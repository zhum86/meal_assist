'use strict';

const APP_ID = 'family-meals';
const FILE_VERSION = 1;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MEALS = ['breakfast', 'lunch', 'dinner'];

const state = {
  lang: 'zh',
  tab: 'week',
  weekStart: mondayOf(new Date()),
  menuView: 'week', // 'week' | 'day'
  day: ymd(new Date()), // date shown in the day view; always inside weekStart's week
  editing: false,
  dishSearch: '',
  expanded: new Set(), // grocery items showing their dish breakdown
  // persisted
  dishes: [],    // [{id, name, chef, photo, ingredients: [string], updatedAt}]
  schedules: {}, // {weekStart: {mon: {breakfast: [{dishId, dishName}], lunch: [], dinner: []}, ...}}
  grocery: {},   // {weekStart: {checked: {ingredient: true}, extras: [{id, name, checked}]}}
};

// ---------- helpers ----------

const $ = sel => document.querySelector(sel);

function t(key, vars) {
  let s = I18N[state.lang][key] ?? I18N.en[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
  return s;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return ymd(d);
}

function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function fmtDate(s) {
  return parseYmd(s).toLocaleDateString(state.lang === 'zh' ? 'zh-CN' : 'en-US',
    { month: 'short', day: 'numeric' });
}

function newId(prefix = 'd') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function splitList(text) {
  return text.split(/[,，、;；\n]+/).map(s => s.trim()).filter(Boolean);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------- data access ----------

function emptyWeek() {
  const w = {};
  for (const d of DAYS) w[d] = { breakfast: [], lunch: [], dinner: [] };
  return w;
}

function getWeek(ws, create) {
  if (!state.schedules[ws] && create) state.schedules[ws] = emptyWeek();
  return state.schedules[ws] || null;
}

function getGrocery(ws) {
  if (!state.grocery[ws]) state.grocery[ws] = { checked: {}, extras: [] };
  return state.grocery[ws];
}

function weekEntries(week) {
  const out = [];
  if (!week) return out;
  for (const day of DAYS) for (const meal of MEALS)
    for (const entry of week[day]?.[meal] || []) out.push({ day, meal, entry });
  return out;
}

// Look up by ID first; fall back to name (e.g. same dish created on two phones).
function findDish(entry) {
  return state.dishes.find(d => d.id === entry.dishId)
    || state.dishes.find(d => d.name === entry.dishName)
    || null;
}

function dishUsageCount(dish) {
  let n = 0;
  for (const ws in state.schedules)
    for (const { entry } of weekEntries(state.schedules[ws]))
      if (entry.dishId === dish.id) n++;
  return n;
}

async function persist(key) {
  try {
    await Store.set(key, state[key]);
  } catch (err) {
    toast(t('saveFailed', { err: err?.message || err }));
  }
}

// Saving after state has been changed in memory: on this device only (whole
// collections in IndexedDB), or, in a family, just the changed records in the cloud.
const Save = {
  dish(dish) { Sync.active ? Sync.saveDish(dish) : persist('dishes'); },
  deleteDish(id) { Sync.active ? Sync.deleteDish(id) : persist('dishes'); },
  dishesImported(removedIds, slotsChanged) {
    if (!Sync.active) { persist('dishes'); persist('schedules'); return; }
    Sync.saveAllDishes(removedIds);
    if (slotsChanged) Sync.saveAllSlots();
  },
  slot(ws, day, meal) { Sync.active ? Sync.saveSlot(ws, day, meal) : persist('schedules'); },
  week(ws) { Sync.active ? Sync.saveWeek(ws) : persist('schedules'); },
  checked(ws, name) { Sync.active ? Sync.setChecked(ws, name, !!getGrocery(ws).checked[name]) : persist('grocery'); },
  extra(ws, ex) { Sync.active ? Sync.saveExtra(ws, ex) : persist('grocery'); },
  removeExtra(ws, id) { Sync.active ? Sync.removeExtra(ws, id) : persist('grocery'); },
  grocery(ws) { Sync.active ? Sync.saveGrocery(ws) : persist('grocery'); },
};

// ---------- rendering ----------

function render() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('appTitle');
  $('#app-title').textContent = t('appTitle');
  $('#lang-btn').textContent = t('langSwitch');
  onSyncStatus();
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('.tabbar button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === state.tab));

  const view = $('#view');
  if (state.tab === 'week') view.innerHTML = state.menuView === 'day' ? renderDay() : renderWeek();
  else if (state.tab === 'grocery') view.innerHTML = renderGrocery();
  else { view.innerHTML = renderDishes(); drawDishGrid(); }
}

function thumb(dish, cls = 'thumb') {
  return dish?.photo
    ? `<img class="${cls}" src="${dish.photo}" alt="">`
    : `<span class="${cls} placeholder">🍽️</span>`;
}

function weekNav() {
  const ws = state.weekStart;
  const isThis = ws === mondayOf(new Date());
  return `
    <div class="week-nav">
      <button class="icon-btn" data-action="prev-week" aria-label="${t('prevWeek')}">‹</button>
      <div class="week-title">
        <strong>${isThis ? t('thisWeek') : t('weekOf')}</strong>
        <span>${fmtDate(ws)} – ${fmtDate(addDays(ws, 6))}</span>
      </div>
      <button class="icon-btn" data-action="next-week" aria-label="${t('nextWeek')}">›</button>
    </div>
    ${isThis ? '' : `<div class="center"><button class="link" data-action="this-week">${t('backToThisWeek')}</button></div>`}`;
}

function viewSwitch() {
  return `
    <div class="segmented">
      ${['week', 'day'].map(v => `<button class="${state.menuView === v ? 'active' : ''}" data-action="menu-view" data-view="${v}">${t(v === 'week' ? 'viewWeek' : 'viewDay')}</button>`).join('')}
    </div>`;
}

function editButton() {
  return `<button class="btn ${state.editing ? 'primary' : ''}" data-action="toggle-edit">${state.editing ? t('done') : t('edit')}</button>`;
}

function renderWeek() {
  const ws = state.weekStart;
  const week = getWeek(ws, false);
  const today = ymd(new Date());
  const editing = state.editing;
  let html = viewSwitch() + weekNav();
  html += `
    <div class="toolbar">
      ${editButton()}
      <span class="spacer"></span>
      <button class="btn" data-action="export-schedule">${t('share')}</button>
      <button class="btn" data-action="import-schedule">${t('import')}</button>
    </div>`;

  if (!editing && weekEntries(week).length === 0)
    html += `<p class="hint">${t('emptyWeekHint')}</p>`;

  DAYS.forEach((day, i) => {
    const date = addDays(ws, i);
    const isToday = date === today;
    html += `<section class="day card ${isToday ? 'today' : ''}">
      <h3 class="day-link" data-action="open-day" data-date="${date}">${t('days')[i]} <span class="muted">${fmtDate(date)}</span>${isToday ? ` <span class="badge">${t('today')}</span>` : ''}<span class="go">›</span></h3>`;
    for (const meal of MEALS) {
      const entries = week?.[day]?.[meal] || [];
      html += `<div class="meal"><div class="meal-label">${t(meal)}</div><div class="meal-dishes">`;
      entries.forEach((entry, idx) => {
        const dish = findDish(entry);
        const name = dish ? dish.name : entry.dishName;
        html += `<div class="chip ${dish ? '' : 'missing'}" ${dish ? `data-action="view-dish" data-id="${esc(dish.id)}"` : ''}>
          ${thumb(dish)}<span class="chip-name">${esc(name)}${dish ? '' : `<small>${t('notInDb')}</small>`}</span>
          ${editing ? removeButton(day, meal, idx) : ''}
        </div>`;
      });
      if (editing)
        html += `<button class="chip add" data-action="add-entry" data-day="${day}" data-meal="${meal}">+ ${t('addDish')}</button>`;
      else if (!entries.length)
        html += `<span class="muted">—</span>`;
      html += `</div></div>`;
    }
    html += `</section>`;
  });
  return html;
}

function removeButton(day, meal, idx) {
  return `<button class="x" data-action="remove-entry" data-day="${day}" data-meal="${meal}" data-idx="${idx}" aria-label="${t('delete')}">×</button>`;
}

function renderDay() {
  const date = state.day;
  const today = ymd(new Date());
  const i = (parseYmd(date).getDay() + 6) % 7;
  const day = DAYS[i];
  const meals = getWeek(state.weekStart, false)?.[day];
  const editing = state.editing;

  let html = viewSwitch() + `
    <div class="week-nav">
      <button class="icon-btn" data-action="prev-day" aria-label="${t('prevDay')}">‹</button>
      <div class="week-title">
        <strong>${t('days')[i]}${date === today ? ` <span class="badge">${t('today')}</span>` : ''}</strong>
        <span>${fmtDate(date)}</span>
      </div>
      <button class="icon-btn" data-action="next-day" aria-label="${t('nextDay')}">›</button>
    </div>
    ${date === today ? '' : `<div class="center"><button class="link" data-action="go-today">${t('backToToday')}</button></div>`}
    <div class="toolbar">${editButton()}</div>`;

  for (const meal of MEALS) {
    const entries = meals?.[meal] || [];
    html += `<section class="card"><h3>${t(meal)}</h3>`;
    entries.forEach((entry, idx) => {
      const dish = findDish(entry);
      html += `<div class="day-dish ${dish ? '' : 'missing'}" ${dish ? `data-action="view-dish" data-id="${esc(dish.id)}"` : ''}>
        ${thumb(dish, 'day-photo')}
        <div class="day-dish-info">
          <strong>${esc(dish ? dish.name : entry.dishName)}</strong>
          ${dish ? `<span class="muted small">${esc(dish.chef || '')}</span>
            <span class="muted small ings">${esc(dish.ingredients.join('、'))}</span>`
            : `<span class="small warn-text">${t('notInDb')}</span>`}
        </div>
        ${editing ? removeButton(day, meal, idx) : ''}
      </div>`;
    });
    if (editing)
      html += `<button class="chip add" data-action="add-entry" data-day="${day}" data-meal="${meal}">+ ${t('addDish')}</button>`;
    else if (!entries.length)
      html += `<span class="muted">—</span>`;
    html += `</section>`;
  }
  return html;
}

// Day view and week navigation share one position: keep state.day inside state.weekStart's week.
function setDay(date) {
  state.day = date;
  state.weekStart = mondayOf(parseYmd(date));
  state.expanded.clear();
}

function setWeek(ws) {
  state.weekStart = ws;
  const today = ymd(new Date());
  state.day = mondayOf(new Date()) === ws ? today : ws;
  state.expanded.clear();
}

function computeGrocery(ws) {
  const items = new Map();
  const missing = [];
  for (const { entry } of weekEntries(getWeek(ws, false))) {
    const dish = findDish(entry);
    if (!dish) { missing.push(entry.dishName); continue; }
    for (const ing of new Set(dish.ingredients.map(s => s.trim()).filter(Boolean))) {
      if (!items.has(ing)) items.set(ing, { name: ing, count: 0, dishes: new Map() });
      const it = items.get(ing);
      it.count++;
      it.dishes.set(dish.name, (it.dishes.get(dish.name) || 0) + 1);
    }
  }
  return { items: [...items.values()], missing: [...new Set(missing)] };
}

function renderGrocery() {
  const ws = state.weekStart;
  const g = getGrocery(ws);
  const { items, missing } = computeGrocery(ws);
  const collator = new Intl.Collator(state.lang === 'zh' ? 'zh-CN' : 'en');
  items.sort((a, b) => (!!g.checked[a.name] - !!g.checked[b.name])
    || (b.count - a.count) || collator.compare(a.name, b.name));

  let html = weekNav();
  if (missing.length)
    html += `<div class="warning">⚠️ ${esc(t('missingWarning', { n: missing.length, names: missing.join('、') }))}</div>`;

  html += `<section class="card"><h3>${t('fromSchedule')}</h3>`;
  if (!items.length) html += `<p class="muted">${t('emptyGrocery')}</p>`;
  html += `<ul class="checklist">`;
  for (const it of items) {
    const checked = !!g.checked[it.name];
    const open = state.expanded.has(it.name);
    html += `<li class="${checked ? 'checked' : ''}" data-action="check-ing" data-name="${esc(it.name)}">
      <span class="box">${checked ? '✓' : ''}</span>
      <span class="item-name">${esc(it.name)}</span>
      <button class="count" data-action="expand-ing" data-name="${esc(it.name)}">${it.count === 1 ? t('neededBy1') : t('neededBy', { n: it.count })} ${open ? '▴' : '▾'}</button>
      ${open ? `<div class="breakdown">${[...it.dishes].map(([n, c]) => esc(c > 1 ? `${n} ×${c}` : n)).join('、')}</div>` : ''}
    </li>`;
  }
  html += `</ul></section>`;

  html += `<section class="card"><h3>${t('otherItems')}</h3>
    <form class="row" data-form="add-extra">
      <input name="item" placeholder="${t('addItemPh')}" autocomplete="off">
      <button class="btn primary" type="submit">${t('add')}</button>
    </form>
    <ul class="checklist">`;
  const extras = [...g.extras].sort((a, b) => a.checked - b.checked);
  for (const ex of extras) {
    html += `<li class="${ex.checked ? 'checked' : ''}" data-action="check-extra" data-id="${esc(ex.id)}">
      <span class="box">${ex.checked ? '✓' : ''}</span>
      <span class="item-name">${esc(ex.name)}</span>
      <button class="x" data-action="remove-extra" data-id="${esc(ex.id)}" aria-label="${t('delete')}">×</button>
    </li>`;
  }
  html += `</ul></section>`;

  if (Object.values(g.checked).some(Boolean) || g.extras.some(e => e.checked))
    html += `<div class="center"><button class="link" data-action="reset-checks">${t('resetChecks')}</button></div>`;
  return html;
}

function renderDishes() {
  return `
    <div class="toolbar">
      <button class="btn primary" data-action="new-dish">+ ${t('newDish')}</button>
      <span class="spacer"></span>
      <button class="btn" data-action="export-dishes">${t('share')}</button>
      <button class="btn" data-action="import-dishes">${t('import')}</button>
    </div>
    <input id="dish-search" class="search" type="search" placeholder="${t('searchDishes')}" value="${esc(state.dishSearch)}">
    <p class="muted small" id="dish-count"></p>
    <div id="dish-grid" class="dish-grid"></div>`;
}

function filterDishes(query) {
  const q = query.trim().toLowerCase();
  const list = q ? state.dishes.filter(d =>
    d.name.toLowerCase().includes(q)
    || (d.chef || '').toLowerCase().includes(q)
    || d.ingredients.some(i => i.toLowerCase().includes(q))) : [...state.dishes];
  const collator = new Intl.Collator('zh-CN');
  return list.sort((a, b) => collator.compare(a.name, b.name));
}

function drawDishGrid() {
  const list = filterDishes(state.dishSearch);
  $('#dish-count').textContent = state.dishes.length ? t('dishCount', { n: state.dishes.length }) : '';
  $('#dish-grid').innerHTML = !state.dishes.length
    ? `<p class="hint">${t('noDishes')}</p>`
    : !list.length ? `<p class="hint">${t('noMatches')}</p>`
    : list.map(d => `
      <button class="dish-card" data-action="edit-dish" data-id="${esc(d.id)}">
        ${thumb(d, 'dish-photo')}
        <span class="dish-name">${esc(d.name)}</span>
        <span class="muted small">${esc(d.chef || '')}</span>
        <span class="muted small ings">${esc(d.ingredients.join('、'))}</span>
      </button>`).join('');
}

// ---------- modal ----------

function openModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  document.body.classList.add('modal-open');
  return m.firstElementChild;
}

function closeModal() {
  const m = $('#modal');
  m.hidden = true;
  m.innerHTML = '';
  document.body.classList.remove('modal-open');
}

function openDishView(dish) {
  const sheet = openModal(`
    ${dish.photo ? `<img class="hero" src="${dish.photo}" alt="">` : ''}
    <h2>${esc(dish.name)}</h2>
    ${dish.chef ? `<p class="muted">${t('chef')}${state.lang === 'zh' ? '：' : ': '}${esc(dish.chef)}</p>` : ''}
    <h4>${t('ingredients')}</h4>
    <div class="tags">${dish.ingredients.map(i => `<span class="tag">${esc(i)}</span>`).join('') || `<span class="muted">${t('noIngredients')}</span>`}</div>
    <div class="actions">
      <span class="spacer"></span>
      <button class="btn" id="v-edit">${t('edit')}</button>
      <button class="btn primary" id="v-close">${t('close')}</button>
    </div>`);
  sheet.querySelector('#v-close').onclick = closeModal;
  sheet.querySelector('#v-edit').onclick = () => openDishForm(dish);
}

function openDishForm(existing) {
  const draft = existing
    ? { ...existing, ingredients: [...existing.ingredients] }
    : { id: newId(), name: '', chef: '', photo: null, ingredients: [] };
  const chefs = [...new Set(state.dishes.map(d => d.chef).filter(Boolean))];
  const allIngs = [...new Set(state.dishes.flatMap(d => d.ingredients))];

  const sheet = openModal(`
    <h2>${existing ? t('editDish') : t('newDish')}</h2>
    <div class="photo-edit">
      <div id="f-photo"></div>
      <div class="col">
        <button class="btn" type="button" id="f-pick">${t('choosePhoto')}</button>
        <button class="btn" type="button" id="f-unphoto">${t('removePhoto')}</button>
      </div>
      <input type="file" accept="image/*" id="f-file" hidden>
    </div>
    <label class="field"><span>${t('dishName')}</span>
      <input id="f-name" value="${esc(draft.name)}" placeholder="${t('dishNamePh')}" autocomplete="off"></label>
    <label class="field"><span>${t('chef')}</span>
      <input id="f-chef" list="f-chefs" value="${esc(draft.chef)}" autocomplete="off"></label>
    <datalist id="f-chefs">${chefs.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="field"><span>${t('ingredients')}</span>
      <div class="tags" id="f-ings"></div>
      <div class="row">
        <input id="f-ing" list="f-allings" placeholder="${t('ingredientPh')}" autocomplete="off">
        <button class="btn" type="button" id="f-ing-add">${t('add')}</button>
      </div>
    </div>
    <datalist id="f-allings">${allIngs.map(i => `<option value="${esc(i)}">`).join('')}</datalist>
    <p class="muted small">ID: ${esc(draft.id)}</p>
    <div class="actions">
      ${existing ? `<button class="btn danger" type="button" id="f-del">${t('delete')}</button>` : ''}
      <span class="spacer"></span>
      <button class="btn" type="button" id="f-cancel">${t('cancel')}</button>
      <button class="btn primary" type="button" id="f-save">${t('save')}</button>
    </div>`);

  const q = sel => sheet.querySelector(sel);

  const drawPhoto = () => {
    q('#f-photo').innerHTML = thumb(draft.photo ? draft : null, 'dish-photo');
    q('#f-unphoto').hidden = !draft.photo;
  };
  const drawIngs = () => {
    q('#f-ings').innerHTML = draft.ingredients.map((ing, i) =>
      `<span class="tag">${esc(ing)}<button type="button" data-i="${i}" aria-label="${t('delete')}">×</button></span>`).join('')
      || `<span class="muted small">${t('noIngredients')}</span>`;
  };
  const addIngs = () => {
    for (const ing of splitList(q('#f-ing').value))
      if (!draft.ingredients.includes(ing)) draft.ingredients.push(ing);
    q('#f-ing').value = '';
    drawIngs();
  };

  q('#f-pick').onclick = () => q('#f-file').click();
  const crop = async src => {
    try {
      const photo = await PhotoCropper.open(src);
      if (photo) { draft.photo = photo; drawPhoto(); }
    } catch { toast(t('photoFailed')); }
  };
  q('#f-file').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = ''; // allow picking the same file again
    if (!file) return;
    const url = URL.createObjectURL(file);
    await crop(url);
    URL.revokeObjectURL(url);
  };
  q('#f-unphoto').onclick = () => { draft.photo = null; drawPhoto(); };
  q('#f-ing-add').onclick = addIngs;
  q('#f-ing').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addIngs(); } };
  q('#f-ings').onclick = e => {
    const b = e.target.closest('button[data-i]');
    if (b) { draft.ingredients.splice(+b.dataset.i, 1); drawIngs(); }
  };
  q('#f-cancel').onclick = closeModal;

  q('#f-save').onclick = () => {
    addIngs(); // include anything typed but not yet added
    draft.name = q('#f-name').value.trim();
    draft.chef = q('#f-chef').value.trim();
    if (!draft.name) return toast(t('dishNameRequired'));
    if (state.dishes.some(d => d.name === draft.name && d.id !== draft.id)) return toast(t('dishNameDuplicate'));
    draft.updatedAt = Date.now();
    const idx = state.dishes.findIndex(d => d.id === draft.id);
    if (idx >= 0) state.dishes[idx] = draft; else state.dishes.push(draft);
    Save.dish(draft);
    closeModal();
    render();
    toast(t('saved'));
  };

  if (existing) q('#f-del').onclick = () => {
    const used = dishUsageCount(existing);
    const msg = used ? t('confirmDeleteDishUsed', { name: existing.name, n: used }) : t('confirmDeleteDish', { name: existing.name });
    if (!confirm(msg)) return;
    state.dishes = state.dishes.filter(d => d.id !== existing.id);
    Save.deleteDish(existing.id);
    closeModal();
    render();
    toast(t('deleted'));
  };

  drawPhoto();
  drawIngs();
  if (!existing) q('#f-name').focus();
}

function openPicker(day, meal) {
  const dayLabel = t('days')[DAYS.indexOf(day)];
  const sheet = openModal(`
    <h2>${t('pickDish')} · ${dayLabel} ${t(meal)}</h2>
    <input id="p-search" class="search" type="search" placeholder="${t('searchDishes')}">
    <div id="p-list" class="pick-list"></div>
    <div class="actions"><span class="spacer"></span>
      <button class="btn primary" id="p-done">${t('done')}</button></div>`);
  const q = sel => sheet.querySelector(sel);
  const slot = () => getWeek(state.weekStart, true)[day][meal];

  const draw = () => {
    const list = filterDishes(q('#p-search').value);
    const inSlot = new Set(slot().map(e => e.dishId));
    q('#p-list').innerHTML = !state.dishes.length ? `<p class="hint">${t('noDishes')}</p>`
      : !list.length ? `<p class="hint">${t('noMatches')}</p>`
      : list.map(d => `
        <button class="pick-item ${inSlot.has(d.id) ? 'picked' : ''}" data-id="${esc(d.id)}">
          ${thumb(d)}<span class="chip-name">${esc(d.name)}<small>${esc(d.chef || '')}</small></span>
          ${inSlot.has(d.id) ? `<span class="badge">✓ ${t('added')}</span>` : ''}
        </button>`).join('');
  };

  q('#p-search').oninput = draw;
  q('#p-done').onclick = closeModal;
  q('#p-list').onclick = e => {
    const b = e.target.closest('.pick-item');
    if (!b) return;
    const dish = state.dishes.find(d => d.id === b.dataset.id);
    const entries = slot();
    const existing = entries.findIndex(en => en.dishId === dish.id);
    if (existing >= 0) entries.splice(existing, 1); // tap again to remove
    else entries.push({ dishId: dish.id, dishName: dish.name });
    Save.slot(state.weekStart, day, meal);
    draw();
    render();
  };
  draw();
}

// ---------- share / import ----------

async function shareJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportDishes() {
  if (!state.dishes.length) return toast(t('nothingToShare'));
  shareJson(`dishes-${ymd(new Date())}.json`, {
    app: APP_ID, kind: 'dishes', version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    dishes: state.dishes.map(({ id, name, chef, photo, ingredients, updatedAt }) =>
      ({ id, name, chef, photo, ingredients, updatedAt })),
  });
}

function exportSchedule() {
  const ws = state.weekStart;
  const meals = weekEntries(getWeek(ws, false)).map(({ day, meal, entry }) => {
    const dish = findDish(entry);
    return { day, meal, dishId: dish ? dish.id : entry.dishId, dishName: dish ? dish.name : entry.dishName };
  });
  if (!meals.length) return toast(t('nothingToShare'));
  shareJson(`schedule-${ws}.json`, {
    app: APP_ID, kind: 'schedule', version: FILE_VERSION,
    exportedAt: new Date().toISOString(), weekStart: ws, meals,
  });
}

let importKind = null;
function startImport(kind) {
  importKind = kind;
  const input = $('#import-input');
  input.value = '';
  input.click();
}

async function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const kindLabel = t(importKind === 'dishes' ? 'kindDishes' : 'kindSchedule');
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.app !== APP_ID || data.kind !== importKind)
    return toast(t('invalidFile', { kind: kindLabel }));
  if (importKind === 'dishes') importDishes(data);
  else importSchedule(data);
}

function cleanDish(raw) {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: raw.name.trim(),
    chef: typeof raw.chef === 'string' ? raw.chef.trim() : '',
    photo: typeof raw.photo === 'string' && raw.photo.startsWith('data:image/') ? raw.photo : null,
    ingredients: Array.isArray(raw.ingredients)
      ? [...new Set(raw.ingredients.filter(i => typeof i === 'string').map(i => i.trim()).filter(Boolean))] : [],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function importDishes(data) {
  if (!Array.isArray(data.dishes)) return toast(t('invalidFile', { kind: t('kindDishes') }));
  const seenNames = new Set();
  const incoming = data.dishes.map(cleanDish).filter(d => {
    if (!d || seenNames.has(d.name)) return false;
    seenNames.add(d.name);
    return true;
  });

  const sheet = openModal(`
    <h2>${t('importDishesTitle')}</h2>
    <p>${t('importDishesBody', { n: incoming.length })}</p>
    <button class="option" id="i-merge"><strong>${t('importMerge')}</strong><span class="muted small">${t('importMergeHelp')}</span></button>
    <button class="option" id="i-replace"><strong>${t('importReplace')}</strong><span class="muted small">${t('importReplaceHelp')}</span></button>
    <div class="actions"><span class="spacer"></span><button class="btn" id="i-cancel">${t('cancel')}</button></div>`);

  const before = new Set(state.dishes.map(d => d.id));
  let remapped = 0;
  const finish = () => {
    const after = new Set(state.dishes.map(d => d.id));
    Save.dishesImported([...before].filter(id => !after.has(id)), remapped > 0);
    closeModal();
    render();
    toast(t('importedDishes', { n: incoming.length }));
  };

  sheet.querySelector('#i-cancel').onclick = closeModal;
  sheet.querySelector('#i-replace').onclick = () => { state.dishes = incoming; finish(); };
  sheet.querySelector('#i-merge').onclick = () => {
    for (const dish of incoming) {
      const byId = state.dishes.findIndex(d => d.id === dish.id);
      if (byId >= 0) {
        // Another local dish may already hold the incoming (renamed) name; drop it.
        const clash = state.dishes.find(d => d.name === dish.name && d.id !== dish.id);
        if (clash) { remapped += remapDishId(clash.id, dish.id); state.dishes = state.dishes.filter(d => d !== clash); }
        state.dishes[state.dishes.findIndex(d => d.id === dish.id)] = dish;
        continue;
      }
      const byName = state.dishes.find(d => d.name === dish.name);
      if (byName) {
        // Same dish created separately on two phones: adopt the incoming ID.
        remapped += remapDishId(byName.id, dish.id);
        state.dishes = state.dishes.filter(d => d !== byName);
      }
      state.dishes.push(dish);
    }
    finish();
  };
}

function remapDishId(oldId, newIdValue) {
  let n = 0;
  for (const ws in state.schedules)
    for (const { entry } of weekEntries(state.schedules[ws]))
      if (entry.dishId === oldId) { entry.dishId = newIdValue; n++; }
  return n;
}

function importSchedule(data) {
  const kind = t('kindSchedule');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.weekStart) || !Array.isArray(data.meals))
    return toast(t('invalidFile', { kind }));
  const ws = mondayOf(parseYmd(data.weekStart));
  const week = emptyWeek();
  for (const m of data.meals) {
    if (!DAYS.includes(m?.day) || !MEALS.includes(m?.meal) || typeof m.dishName !== 'string' || !m.dishName.trim()) continue;
    week[m.day][m.meal].push({ dishId: typeof m.dishId === 'string' ? m.dishId : '', dishName: m.dishName.trim() });
  }
  if (weekEntries(getWeek(ws, false)).length && !confirm(t('confirmReplaceWeek', { date: fmtDate(ws) }))) return;
  state.schedules[ws] = week;
  setWeek(ws);
  state.tab = 'week';
  Save.week(ws);
  render();
  toast(t('importedSchedule', { date: fmtDate(ws) }));
}

// ---------- actions ----------

function saveMenuView() {
  try { localStorage.setItem('fm-menu-view', state.menuView); } catch {}
}

const actions = {
  'open-sync'() { openSyncPanel(); },
  'toggle-lang'() {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem('fm-lang', state.lang); } catch {}
    render();
  },
  tab(el) { state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  'prev-week'() { setWeek(addDays(state.weekStart, -7)); render(); },
  'next-week'() { setWeek(addDays(state.weekStart, 7)); render(); },
  'this-week'() { setWeek(mondayOf(new Date())); render(); },
  'prev-day'() { setDay(addDays(state.day, -1)); render(); },
  'next-day'() { setDay(addDays(state.day, 1)); render(); },
  'go-today'() { setDay(ymd(new Date())); render(); },
  'open-day'(el) { setDay(el.dataset.date); state.menuView = 'day'; saveMenuView(); render(); window.scrollTo(0, 0); },
  'menu-view'(el) { state.menuView = el.dataset.view; saveMenuView(); render(); },
  'toggle-edit'() { state.editing = !state.editing; render(); },
  'add-entry'(el) { openPicker(el.dataset.day, el.dataset.meal); },
  'remove-entry'(el) {
    const { day, meal } = el.dataset;
    getWeek(state.weekStart, true)[day][meal].splice(+el.dataset.idx, 1);
    Save.slot(state.weekStart, day, meal);
    render();
  },
  'view-dish'(el) {
    const dish = state.dishes.find(d => d.id === el.dataset.id);
    if (dish) openDishView(dish);
  },
  'new-dish'() { openDishForm(null); },
  'edit-dish'(el) {
    const dish = state.dishes.find(d => d.id === el.dataset.id);
    if (dish) openDishForm(dish);
  },
  'export-dishes': exportDishes,
  'import-dishes'() { startImport('dishes'); },
  'export-schedule': exportSchedule,
  'import-schedule'() { startImport('schedule'); },
  'check-ing'(el) {
    const g = getGrocery(state.weekStart);
    const name = el.dataset.name;
    if (g.checked[name]) delete g.checked[name]; else g.checked[name] = true;
    Save.checked(state.weekStart, name);
    render();
  },
  'expand-ing'(el) {
    const name = el.dataset.name;
    if (state.expanded.has(name)) state.expanded.delete(name); else state.expanded.add(name);
    render();
  },
  'check-extra'(el) {
    const ex = getGrocery(state.weekStart).extras.find(x => x.id === el.dataset.id);
    if (ex) { ex.checked = !ex.checked; Save.extra(state.weekStart, ex); render(); }
  },
  'remove-extra'(el) {
    const g = getGrocery(state.weekStart);
    g.extras = g.extras.filter(x => x.id !== el.dataset.id);
    Save.removeExtra(state.weekStart, el.dataset.id);
    render();
  },
  'reset-checks'() {
    const g = getGrocery(state.weekStart);
    g.checked = {};
    g.extras.forEach(x => { x.checked = false; });
    Save.grocery(state.weekStart);
    render();
  },
};

document.addEventListener('click', e => {
  if (e.target === $('#modal')) return closeModal();
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});

document.addEventListener('submit', e => {
  if (e.target.dataset.form !== 'add-extra') return;
  e.preventDefault();
  const g = getGrocery(state.weekStart);
  for (const name of splitList(e.target.item.value)) {
    const ex = { id: newId('x'), name, checked: false, at: Date.now() };
    g.extras.push(ex);
    Save.extra(state.weekStart, ex);
  }
  render();
  $('[data-form="add-extra"] input')?.focus();
});

document.addEventListener('input', e => {
  if (e.target.id === 'dish-search') { state.dishSearch = e.target.value; drawDishGrid(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal').hidden && !document.querySelector('.cropper')) closeModal();
});

$('#import-input').addEventListener('change', onImportFile);

// ---------- family sync ----------

// Remote changes re-render the page, but not while someone is typing in it.
let renderPending = false;
function onRemoteData() {
  if (document.activeElement?.matches('#view input')) { renderPending = true; return; }
  render();
}
document.addEventListener('focusout', () => {
  if (!renderPending) return;
  setTimeout(() => {
    if (document.activeElement?.matches('#view input')) return;
    renderPending = false;
    render();
  }, 300);
});

function syncStatusText() {
  if (!Sync.active) return t('syncLocal');
  if (Sync.status === 'error') return t('syncError', { err: Sync.error });
  return t('sync_' + Sync.status);
}

function onSyncStatus() {
  const btn = $('#sync-btn');
  btn.dataset.status = Sync.active ? Sync.status : 'off';
  btn.title = syncStatusText();
  const line = $('#sync-status');
  if (line) line.textContent = syncStatusText();
}

async function loadLocal() {
  try {
    state.dishes = await Store.get('dishes', []);
    state.schedules = await Store.get('schedules', {});
    state.grocery = await Store.get('grocery', {});
  } catch (err) {
    toast(t('saveFailed', { err: err?.message || err }));
  }
}

function inviteLink(code) {
  return `${location.origin}${location.pathname}?family=${code}`;
}

async function shareInvite(code) {
  const url = inviteLink(code);
  const text = t('inviteText', { code: Sync.format(code) });
  if (navigator.share) {
    try { await navigator.share({ title: t('appTitle'), text, url }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast(t('copied')); }
  catch { prompt(t('familyCode'), url); }
}

// Runs a sync step with the panel's buttons disabled; returns false if it failed.
async function busy(sheet, work) {
  const controls = sheet ? [...sheet.querySelectorAll('button, input')] : [];
  controls.forEach(el => { el.disabled = true; });
  toast(t('working'));
  try {
    await work();
    return true;
  } catch (err) {
    toast(t('syncFailed', { err: err?.code || err?.message || err }));
    return false;
  } finally {
    controls.forEach(el => { el.disabled = false; });
  }
}

async function joinFamily(code, sheet) {
  let found = false;
  if (!(await busy(sheet, async () => { found = await Sync.join(code); }))) return;
  if (!found) return toast(t('noSuchFamily'));
  closeModal();
  render();
  toast(t('joined'));
}

function openSyncPanel() {
  if (!Sync.available) {
    const sheet = openModal(`
      <h2>${t('syncTitle')}</h2>
      <p>${location.protocol.startsWith('http') ? t('syncNotConfigured') : t('syncNeedsWeb')}</p>
      <div class="actions"><span class="spacer"></span><button class="btn primary" id="s-close">${t('close')}</button></div>`);
    sheet.querySelector('#s-close').onclick = closeModal;
    return;
  }

  if (Sync.active) {
    const sheet = openModal(`
      <h2>${t('syncTitle')}</h2>
      <p id="sync-status" class="muted"></p>
      <div class="field"><span>${t('familyCode')}</span><div class="family-code">${Sync.format(Sync.code)}</div></div>
      <p class="muted small">${t('codeWarning')}</p>
      <div class="actions">
        <button class="btn danger" id="s-leave">${t('leaveFamily')}</button>
        <span class="spacer"></span>
        <button class="btn" id="s-invite">${t('shareInvite')}</button>
        <button class="btn primary" id="s-close">${t('close')}</button>
      </div>`);
    sheet.querySelector('#s-close').onclick = closeModal;
    sheet.querySelector('#s-invite').onclick = () => shareInvite(Sync.code);
    sheet.querySelector('#s-leave').onclick = async () => {
      if (!confirm(t('confirmLeave'))) return;
      Sync.leave();
      await loadLocal();
      closeModal();
      render();
      toast(t('left'));
    };
    onSyncStatus();
    return;
  }

  const sheet = openModal(`
    <h2>${t('syncTitle')}</h2>
    <p>${t('syncIntro')}</p>
    ${window.ALLOW_CREATE_FAMILY ? `<button class="option" id="s-create"><strong>${t('createFamily')}</strong><span class="muted small">${t('createHelp')}</span></button>` : ''}
    <div class="option">
      <strong>${t('joinFamily')}</strong><span class="muted small">${t('joinHelp')}</span>
      <form class="row join-form" id="s-join">
        <input name="code" placeholder="${t('codePh')}" autocomplete="off" autocapitalize="characters" spellcheck="false">
        <button class="btn primary" type="submit">${t('join')}</button>
      </form>
    </div>
    <div class="actions"><span class="spacer"></span><button class="btn" id="s-close">${t('close')}</button></div>`);
  sheet.querySelector('#s-close').onclick = closeModal;
  if (window.ALLOW_CREATE_FAMILY) sheet.querySelector('#s-create').onclick = async () => {
    if (!(await busy(sheet, () => Sync.create()))) return;
    render();
    toast(t('created'));
    openSyncPanel(); // show the new code and the invite button
  };
  sheet.querySelector('#s-join').onsubmit = e => {
    e.preventDefault();
    const code = Sync.normalize(e.target.code.value);
    if (!Sync.isValid(code)) return toast(t('badCode'));
    joinFamily(code, sheet);
  };
}

// An invite link (?family=CODE) offers to join that family.
function checkInviteLink() {
  const params = new URLSearchParams(location.search);
  if (!params.has('family')) return;
  const code = Sync.normalize(params.get('family'));
  history.replaceState(null, '', location.pathname);
  if (!Sync.available || !Sync.isValid(code) || code === Sync.code) return;
  if (confirm(t('joinConfirm', { code: Sync.format(code) }))) joinFamily(code, null);
}

// ---------- start ----------

(async function init() {
  let lang = null;
  try { lang = localStorage.getItem('fm-lang'); } catch {}
  state.lang = lang === 'en' ? 'en' : 'zh';
  try { state.menuView = localStorage.getItem('fm-menu-view') === 'day' ? 'day' : 'week'; } catch {}

  if (Sync.savedCode() && Sync.available) Sync.resume();
  else await loadLocal();
  render();
  checkInviteLink();

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
    navigator.serviceWorker.register('sw.js').catch(() => {});
})();
