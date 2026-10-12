'use strict';

const APP_ID = 'family-meals';
const FILE_VERSION = 1;
// Weeks start on Wednesday (the family shops Monday/Tuesday for the week ahead).
const WEEK_START_DAY = 3; // Date.getDay() of the first day of a week
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date.getDay() order
const DAYS = [...WEEKDAY_KEYS.slice(WEEK_START_DAY), ...WEEKDAY_KEYS.slice(0, WEEK_START_DAY)]; // order within a week
const SHOPPING_DAYS = ['mon', 'tue']; // on these days the grocery tab opens on the upcoming week
const MEALS = ['breakfast', 'lunch', 'dinner'];
const STORES = [
  { id: 'wholefoods', name: 'Whole Foods' },
  { id: 'cam', name: 'CAM' },
  { id: 'target', name: 'Target' },
  { id: 'costco', name: 'Costco' },
];

const state = {
  lang: 'zh',
  tab: 'week',
  weekStart: weekStartOf(new Date()),
  menuView: 'week', // 'week' | 'day'
  day: ymd(new Date()), // date shown in the day view; always inside weekStart's week
  editing: false,
  groceryView: 'plan', // 'plan' | 'shop'
  dishSearch: '',
  expanded: new Set(), // grocery items showing their dish breakdown
  // persisted
  dishes: [],    // [{id, name, chef, photo, ingredients: [string], updatedAt}]
  schedules: {}, // {weekStart: {mon: {breakfast: [{dishId, dishName}], lunch: [], dinner: []}, ...}}
  grocery: {},   // {weekStart: {have: {needKey: true}, extras: [{id, name, checked, at}]}}
  itemStores: {}, // {itemName: storeId} preferred store per grocery item
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

function weekStartOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - (d.getDay() - WEEK_START_DAY + 7) % 7);
  return ymd(d);
}

const dayKeyOf = date => WEEKDAY_KEYS[parseYmd(date).getDay()];

// The date of weekday `day` in the 7 days starting at `start` (any weekday).
function dateFrom(start, day) {
  return addDays(start, (WEEKDAY_KEYS.indexOf(day) - parseYmd(start).getDay() + 7) % 7);
}

// I18N day names are listed Monday first.
const dayLabel = day => t('days')[(WEEKDAY_KEYS.indexOf(day) + 6) % 7];

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
  const g = state.grocery[ws] || (state.grocery[ws] = { have: {}, extras: [] });
  if (!g.have) { g.have = {}; delete g.checked; } // lists saved before per-meal ticks
  return g;
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
  have(ws, keys) { Sync.active ? Sync.setHave(ws, keys) : persist('grocery'); },
  itemStore(name) { Sync.active ? Sync.saveItemStore(name) : persist('itemStores'); },
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
  const isThis = ws === weekStartOf(new Date());
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
      <h3 class="day-link" data-action="open-day" data-date="${date}">${dayLabel(day)} <span class="muted">${fmtDate(date)}</span>${isToday ? ` <span class="badge">${t('today')}</span>` : ''}<span class="go">›</span></h3>`;
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
  const day = dayKeyOf(date);
  const meals = getWeek(state.weekStart, false)?.[day];
  const editing = state.editing;

  let html = viewSwitch() + `
    <div class="week-nav">
      <button class="icon-btn" data-action="prev-day" aria-label="${t('prevDay')}">‹</button>
      <div class="week-title">
        <strong>${dayLabel(day)}${date === today ? ` <span class="badge">${t('today')}</span>` : ''}</strong>
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
  state.weekStart = weekStartOf(parseYmd(date));
  state.expanded.clear();
}

function setWeek(ws) {
  state.weekStart = ws;
  const today = ymd(new Date());
  state.day = weekStartOf(new Date()) === ws ? today : ws;
  state.expanded.clear();
}

// Each ingredient lists the meals that need it; a meal's need is ticked off
// (already have it / bought) by its own key, so leftovers can cover some meals.
function needKey(date, meal, dishId, ingredient) {
  return `${date}|${meal}|${dishId}|${ingredient}`;
}

function computeGrocery(ws) {
  const g = getGrocery(ws);
  const items = new Map();
  const missing = [];
  for (const { day, meal, entry } of weekEntries(getWeek(ws, false))) {
    const dish = findDish(entry);
    if (!dish) { missing.push(entry.dishName); continue; }
    const date = addDays(ws, DAYS.indexOf(day));
    for (const ing of new Set(dish.ingredients.map(s => s.trim()).filter(Boolean))) {
      if (!items.has(ing)) items.set(ing, { name: ing, needs: [] });
      const key = needKey(date, meal, dish.id, ing);
      items.get(ing).needs.push({ key, day, meal, dish: dish.name, done: !!g.have[key] });
    }
  }
  for (const it of items.values()) {
    it.count = it.needs.length;
    it.left = it.needs.filter(n => !n.done).length;
  }
  return { items: [...items.values()], missing: [...new Set(missing)] };
}

function storeTag(name) {
  const store = STORES.find(s => s.id === state.itemStores[name]);
  return `<button class="store-tag ${store ? `store-${store.id}` : 'none'}" data-action="pick-store" data-name="${esc(name)}">${store ? esc(store.name) : t('storeTag')}</button>`;
}

function countLabel(it) {
  const label = it.left === 1 ? t('neededBy1') : t('neededBy', { n: it.left });
  return it.left && it.left < it.count ? `${label} · ${t('haveCount', { n: it.count - it.left })}` : label;
}

function ingredientRow(it, withBreakdown) {
  const done = it.left === 0;
  const open = withBreakdown && state.expanded.has(it.name);
  let html = `<li class="${done ? 'checked' : ''}" data-action="check-ing" data-name="${esc(it.name)}">
    <span class="box">${done ? '✓' : ''}</span>
    <span class="item-name">${esc(it.name)}</span>
    ${storeTag(it.name)}
    ${withBreakdown
      ? `<button class="count" data-action="expand-ing" data-name="${esc(it.name)}">${done ? (it.count === 1 ? t('neededBy1') : t('neededBy', { n: it.count })) : countLabel(it)} ${open ? '▴' : '▾'}</button>`
      : (done ? '' : `<span class="count static">${countLabel(it)}</span>`)}`;
  if (open) {
    html += `<ul class="needs">${it.needs.map(n => `
      <li class="${n.done ? 'checked' : ''}" data-action="check-need" data-key="${esc(n.key)}">
        <span class="box small-box">${n.done ? '✓' : ''}</span>
        <span class="item-name">${dayLabel(n.day)} ${t(n.meal)} · ${esc(n.dish)}</span>
      </li>`).join('')}</ul>`;
  }
  return html + `</li>`;
}

function extraRow(ex, removable) {
  return `<li class="${ex.checked ? 'checked' : ''}" data-action="check-extra" data-id="${esc(ex.id)}">
    <span class="box">${ex.checked ? '✓' : ''}</span>
    <span class="item-name">${esc(ex.name)}</span>
    ${storeTag(ex.name)}
    ${removable ? `<button class="x" data-action="remove-extra" data-id="${esc(ex.id)}" aria-label="${t('delete')}">×</button>` : ''}
  </li>`;
}

function renderGrocery() {
  const ws = state.weekStart;
  const g = getGrocery(ws);
  const { items, missing } = computeGrocery(ws);
  // Pinyin order (zh-CN collation); ticked items stay in place. Other items keep the order added.
  const pinyin = new Intl.Collator('zh-CN');
  items.sort((a, b) => pinyin.compare(a.name, b.name));
  const extras = g.extras;

  let html = weekNav() + `
    <div class="segmented">
      ${['plan', 'shop'].map(v => `<button class="${state.groceryView === v ? 'active' : ''}" data-action="grocery-view" data-view="${v}">${t(v === 'plan' ? 'groceryPlan' : 'groceryShop')}</button>`).join('')}
    </div>`;
  if (missing.length)
    html += `<div class="warning">⚠️ ${esc(t('missingWarning', { n: missing.length, names: missing.join('、') }))}</div>`;

  html += state.groceryView === 'shop' ? renderShopList(items, extras) : renderPlanList(items, extras);

  if (Object.keys(g.have).length || g.extras.some(e => e.checked))
    html += `<div class="center"><button class="link" data-action="reset-checks">${t('resetChecks')}</button></div>`;
  return html;
}

function renderPlanList(items, extras) {
  let html = `<section class="card"><h3>${t('fromSchedule')}</h3>`;
  if (!items.length) html += `<p class="muted">${t('emptyGrocery')}</p>`;
  html += `<ul class="checklist">${items.map(it => ingredientRow(it, true)).join('')}</ul></section>`;

  html += `<section class="card"><h3>${t('otherItems')}</h3>
    <form class="row" data-form="add-extra">
      <input name="item" placeholder="${t('addItemPh')}" autocomplete="off">
      <button class="btn primary" type="submit">${t('add')}</button>
    </form>
    <ul class="checklist">${extras.map(ex => extraRow(ex, true)).join('')}</ul></section>`;
  return html;
}

// Everything on the list grouped by preferred store.
function renderShopList(items, extras) {
  const groups = [...STORES, { id: '', name: t('noStore') }].map(s => ({ ...s, rows: [], left: 0 }));
  const groupOf = name => groups.find(gr => gr.id === (state.itemStores[name] || '')) || groups[groups.length - 1];
  for (const it of items) {
    const gr = groupOf(it.name);
    gr.rows.push({ done: !it.left, html: ingredientRow(it, false) });
    if (it.left) gr.left++;
  }
  for (const ex of extras) {
    const gr = groupOf(ex.name);
    gr.rows.push({ done: ex.checked, html: extraRow(ex, false) });
    if (!ex.checked) gr.left++;
  }
  const used = groups.filter(gr => gr.rows.length);
  if (!used.length) return `<p class="hint">${t('emptyGrocery')}</p>`;
  if (!used.some(gr => gr.left)) return `<p class="hint">${t('allBought')}</p>` + shopGroups(used);
  return shopGroups(used);
}

function shopGroups(groups) {
  return groups.map(gr => `
    <section class="card">
      <h3 class="store-head">${gr.id ? `<span class="store-dot store-${gr.id}"></span>` : ''}${esc(gr.name)} <span class="muted">${gr.left}</span></h3>
      <ul class="checklist">${gr.rows.map(r => r.html).join('')}</ul>
    </section>`).join('');
}

function openStorePicker(name) {
  const current = state.itemStores[name] || '';
  const sheet = openModal(`
    <h2>${t('storeFor', { name: esc(name) })}</h2>
    <div class="store-options">
      ${[...STORES, { id: '', name: t('noStore') }].map(s => `
        <button class="option store-option ${s.id === current ? 'selected' : ''}" data-store="${s.id}">
          <strong>${s.id ? `<span class="store-dot store-${s.id}"></span>` : ''}${esc(s.name)}</strong>
        </button>`).join('')}
    </div>
    <p class="muted small">${t('storeRemember')}</p>
    <div class="actions"><span class="spacer"></span><button class="btn" id="st-close">${t('close')}</button></div>`);
  sheet.querySelector('#st-close').onclick = closeModal;
  sheet.querySelector('.store-options').onclick = e => {
    const b = e.target.closest('[data-store]');
    if (!b) return;
    if (b.dataset.store) state.itemStores[name] = b.dataset.store;
    else delete state.itemStores[name];
    Save.itemStore(name);
    closeModal();
    render();
  };
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
  const sheet = openModal(`
    <h2>${t('pickDish')} · ${dayLabel(day)} ${t(meal)}</h2>
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
  // Meals are placed by date, so files whose week starts on another weekday still fit.
  const start = data.weekStart;
  const dates = DAYS.map((_, i) => addDays(start, i));
  const incoming = {};
  for (const m of data.meals) {
    if (!DAYS.includes(m?.day) || !MEALS.includes(m?.meal) || typeof m.dishName !== 'string' || !m.dishName.trim()) continue;
    const k = `${dateFrom(start, m.day)}|${m.meal}`;
    (incoming[k] ||= []).push({ dishId: typeof m.dishId === 'string' ? m.dishId : '', dishName: m.dishName.trim() });
  }
  const slotOf = (date, meal) => getWeek(weekStartOf(parseYmd(date)), true)[dayKeyOf(date)][meal];
  const hasMeals = dates.some(date => MEALS.some(meal => getWeek(weekStartOf(parseYmd(date)), false)?.[dayKeyOf(date)][meal].length));
  if (hasMeals && !confirm(t('confirmReplaceWeek', { date: fmtDate(start) }))) return;
  for (const date of dates) for (const meal of MEALS) {
    const slot = slotOf(date, meal);
    slot.splice(0, slot.length, ...(incoming[`${date}|${meal}`] || []));
  }
  const weeks = [...new Set(dates.map(d => weekStartOf(parseYmd(d))))];
  weeks.forEach(ws => Save.week(ws));
  setWeek(weekStartOf(parseYmd(start)));
  state.tab = 'week';
  render();
  toast(t('importedSchedule', { date: fmtDate(start) }));
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
  tab(el) {
    state.tab = el.dataset.tab;
    // Shopping days buy for the week starting Wednesday, so the first grocery visit shows that week.
    if (state.tab === 'grocery' && !state.groceryJumped) {
      state.groceryJumped = true;
      if (SHOPPING_DAYS.includes(dayKeyOf(ymd(new Date()))) && state.weekStart === weekStartOf(new Date()))
        setWeek(addDays(state.weekStart, 7));
    }
    render();
    window.scrollTo(0, 0);
  },
  'prev-week'() { setWeek(addDays(state.weekStart, -7)); render(); },
  'next-week'() { setWeek(addDays(state.weekStart, 7)); render(); },
  'this-week'() { setWeek(weekStartOf(new Date())); render(); },
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
  // Ticking an ingredient covers all meals still needing it; unticking a fully ticked one clears them.
  'check-ing'(el) {
    const ws = state.weekStart;
    const g = getGrocery(ws);
    const it = computeGrocery(ws).items.find(i => i.name === el.dataset.name);
    if (!it) return;
    const on = it.left > 0;
    const keys = it.needs.filter(n => n.done !== on).map(n => n.key);
    keys.forEach(k => { if (on) g.have[k] = true; else delete g.have[k]; });
    Save.have(ws, keys);
    render();
  },
  'check-need'(el) {
    const ws = state.weekStart;
    const g = getGrocery(ws);
    const key = el.dataset.key;
    if (g.have[key]) delete g.have[key]; else g.have[key] = true;
    Save.have(ws, [key]);
    render();
  },
  'pick-store'(el) { openStorePicker(el.dataset.name); },
  'grocery-view'(el) {
    state.groceryView = el.dataset.view;
    try { localStorage.setItem('fm-grocery-view', state.groceryView); } catch {}
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
    g.have = {};
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
    state.itemStores = await Store.get('itemStores', {});
    if (regroupWeeks()) { persist('schedules'); persist('grocery'); }
  } catch (err) {
    toast(t('saveFailed', { err: err?.message || err }));
  }
}

// Data saved when weeks started on Monday is keyed by a Monday: move meals to the
// weeks their dates now belong to, and each grocery list to the Wednesday of its week.
function regroupWeeks() {
  let changed = false;
  for (const ws of Object.keys(state.schedules)) {
    if (ws === weekStartOf(parseYmd(ws))) continue;
    const old = state.schedules[ws];
    delete state.schedules[ws];
    for (const day of DAYS) for (const meal of MEALS) {
      const entries = old[day]?.[meal] || [];
      const date = dateFrom(ws, day);
      if (entries.length) getWeek(weekStartOf(parseYmd(date)), true)[day][meal] = entries;
    }
    changed = true;
  }
  for (const ws of Object.keys(state.grocery)) {
    if (ws === weekStartOf(parseYmd(ws))) continue;
    const old = state.grocery[ws];
    delete state.grocery[ws];
    const g = getGrocery(dateFrom(ws, DAYS[0]));
    Object.assign(g.have, old.have);
    g.extras.push(...(old.extras || []));
    changed = true;
  }
  return changed;
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
  // Listen before anything async: the browser checks for a new version as soon as the page opens.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // A new version takes over in the background; reload once so it shows right away.
    // (No reload on the very first visit, when there was no previous version.)
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      const reloadWhenIdle = () => {
        if (!$('#modal').hidden || document.querySelector('.cropper')) return setTimeout(reloadWhenIdle, 1000);
        location.reload();
      };
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!reloaded) { reloaded = true; reloadWhenIdle(); }
      });
    }
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  let lang = null;
  try { lang = localStorage.getItem('fm-lang'); } catch {}
  state.lang = lang === 'en' ? 'en' : 'zh';
  try {
    state.menuView = localStorage.getItem('fm-menu-view') === 'day' ? 'day' : 'week';
    state.groceryView = localStorage.getItem('fm-grocery-view') === 'shop' ? 'shop' : 'plan';
  } catch {}

  if (Sync.savedCode() && Sync.available) Sync.resume();
  else await loadLocal();
  render();
  checkInviteLink();

  navigator.storage?.persist?.().catch(() => {});
})();
