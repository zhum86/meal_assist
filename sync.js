'use strict';

// Family cloud sync over Firestore. Everything a family shares lives under
// families/{code}; knowing the code is what grants access (see firestore.rules).
//   families/{code}                     {createdAt}
//   families/{code}/dishes/{dishId}     {name, chef, photo, ingredients, updatedAt}
//   families/{code}/slots/{date}_{meal} {date, meal, entries: [{dishId, dishName}]}
//   families/{code}/grocery/{weekStart} {have: {needKey: true}, extras: {id: {name, checked, at}}}
//   families/{code}/settings/stores     {items: {itemName: storeId}}
// Firestore keeps an offline cache, so the app works without signal and catches up later.
const Sync = (() => {
  const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
  const CODE_KEY = 'fm-family';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  const CODE_LEN = 8;

  let fb = null;    // loaded SDK functions
  let db = null;
  let unsubs = [];
  const meta = {};  // per-listener {fromCache, pending}

  const self = {
    code: null,
    status: 'off', // off | connecting | online | pending | offline | error
    error: '',
    get active() { return !!self.code; },
    get available() { return !!window.FIREBASE_CONFIG && location.protocol.startsWith('http'); },
    savedCode() {
      try { return localStorage.getItem(CODE_KEY); } catch { return null; }
    },
  };

  // ---------- codes ----------

  self.normalize = input => String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  self.isValid = code => code.length === CODE_LEN && [...code].every(c => CODE_CHARS.includes(c));
  self.format = code => code.match(/.{1,4}/g).join('-');

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
    return [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  }

  // ---------- connection ----------

  async function connect() {
    if (db) return;
    const [app, auth, fs] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-firestore.js'),
    ]);
    fb = { ...auth, ...fs };
    const fbApp = app.initializeApp(window.FIREBASE_CONFIG);
    db = fs.initializeFirestore(fbApp, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
    // Each device signs in anonymously; the session is remembered, so this also works offline.
    const a = auth.getAuth(fbApp);
    const user = await new Promise(resolve => {
      const off = auth.onAuthStateChanged(a, u => { off(); resolve(u); });
    });
    if (!user) await auth.signInAnonymously(a);
  }

  const familyDoc = code => fb.doc(db, 'families', code);
  const col = name => fb.collection(db, 'families', self.code, name);
  const slotId = (date, meal) => `${date}_${meal}`;

  function setStatus(status, error = '') {
    self.status = status;
    self.error = error;
    onSyncStatus();
  }

  function updateStatus() {
    const all = Object.values(meta);
    if (!all.length) return;
    if (!navigator.onLine) setStatus('offline');
    else if (all.some(m => m.pending)) setStatus('pending');
    else if (all.some(m => m.fromCache)) setStatus('connecting');
    else setStatus('online');
  }

  function listen(name, apply) {
    meta[name] = { fromCache: true, pending: false };
    unsubs.push(fb.onSnapshot(col(name), { includeMetadataChanges: true }, snap => {
      meta[name] = { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites };
      if (snap.docChanges().length || !self.loaded?.[name]) {
        apply(snap.docs);
        self.loaded = { ...self.loaded, [name]: true };
        onRemoteData();
      }
      updateStatus();
    }, err => setStatus('error', err.code || err.message)));
  }

  async function start(code) {
    setStatus('connecting');
    await connect();
    stopListening();
    self.code = code;
    self.loaded = {};
    state.dishes = [];
    state.schedules = {};
    state.grocery = {};
    state.itemStores = {};
    listen('dishes', docs => {
      state.dishes = docs.map(d => {
        const x = d.data();
        return { id: d.id, name: x.name, chef: x.chef || '', photo: x.photo || null, ingredients: x.ingredients || [], updatedAt: x.updatedAt || 0 };
      });
    });
    listen('slots', docs => {
      state.schedules = {};
      for (const d of docs) {
        const { date, meal, entries } = d.data();
        const day = DAYS[(parseYmd(date).getDay() + 6) % 7];
        getWeek(mondayOf(parseYmd(date)), true)[day][meal] = entries || [];
      }
    });
    listen('grocery', docs => {
      state.grocery = {};
      for (const d of docs) {
        const x = d.data();
        state.grocery[d.id] = {
          have: x.have || {},
          extras: Object.entries(x.extras || {})
            .map(([id, e]) => ({ id, name: e.name, checked: !!e.checked, at: e.at || 0 }))
            .sort((a, b) => a.at - b.at),
        };
      }
    });
    listen('settings', docs => {
      state.itemStores = { ...docs.find(d => d.id === 'stores')?.data().items };
    });
  }

  function stopListening() {
    unsubs.forEach(u => u());
    unsubs = [];
    for (const k in meta) delete meta[k];
  }

  self.resume = async () => {
    const code = self.savedCode();
    if (!code || !self.available) return;
    try { await start(code); } catch (err) { setStatus('error', err.message); }
  };

  // New family seeded with everything currently on this device.
  self.create = async () => {
    await connect();
    const code = newCode();
    await fb.setDoc(familyDoc(code), { createdAt: Date.now() });
    const local = { dishes: state.dishes, schedules: state.schedules, grocery: state.grocery, itemStores: state.itemStores };
    self.code = code;
    try { await uploadAll(local); } catch (err) { self.code = null; throw err; }
    localStorage.setItem(CODE_KEY, code);
    await start(code);
    return code;
  };

  self.join = async code => {
    await connect();
    const snap = await fb.getDoc(familyDoc(code));
    if (!snap.exists()) return false;
    localStorage.setItem(CODE_KEY, code);
    await start(code);
    return true;
  };

  self.leave = () => {
    stopListening();
    self.code = null;
    try { localStorage.removeItem(CODE_KEY); } catch {}
    setStatus('off');
  };

  // ---------- writes ----------
  // Firestore applies writes to its local cache at once (snapshots fire immediately)
  // and sends them when online, so these are not awaited by the UI.

  // Batches are capped by count and by size (photos make dish records large).
  async function commitInChunks(ops, perBatch) {
    for (let i = 0; i < ops.length; i += perBatch) {
      const batch = fb.writeBatch(db);
      ops.slice(i, i + perBatch).forEach(op => op(batch));
      await batch.commit();
    }
  }

  const dishData = d => ({ name: d.name, chef: d.chef || '', photo: d.photo || null, ingredients: d.ingredients, updatedAt: d.updatedAt || Date.now() });

  function slotOps(schedules, onlyWeek) {
    const ops = [];
    for (const ws in schedules) {
      if (onlyWeek && ws !== onlyWeek) continue;
      DAYS.forEach((day, i) => {
        const date = addDays(ws, i);
        for (const meal of MEALS) {
          const entries = schedules[ws][day]?.[meal] || [];
          const ref = fb.doc(col('slots'), slotId(date, meal));
          ops.push(b => entries.length ? b.set(ref, { date, meal, entries }) : b.delete(ref));
        }
      });
    }
    return ops;
  }

  async function uploadAll({ dishes, schedules, grocery, itemStores }) {
    await fb.setDoc(storesRef(), { items: { ...itemStores } });
    await commitInChunks(dishes.map(d => b => b.set(fb.doc(col('dishes'), d.id), dishData(d))), 20);
    await commitInChunks(slotOps(schedules), 400);
    await commitInChunks(Object.entries(grocery).map(([ws, g]) => b => b.set(fb.doc(col('grocery'), ws), groceryData(g))), 400);
  }

  function groceryData(g) {
    const extras = {};
    for (const e of g.extras) extras[e.id] = { name: e.name, checked: !!e.checked, at: e.at || Date.now() };
    return { have: { ...g.have }, extras };
  }

  const fail = err => setStatus('error', err.code || err.message);
  const run = promise => promise.catch(fail);
  const groceryRef = ws => fb.doc(col('grocery'), ws);
  const storesRef = () => fb.doc(col('settings'), 'stores');

  self.saveDish = d => run(fb.setDoc(fb.doc(col('dishes'), d.id), dishData(d)));
  self.deleteDish = id => run(fb.deleteDoc(fb.doc(col('dishes'), id)));

  self.saveSlot = (ws, day, meal) => {
    const date = addDays(ws, DAYS.indexOf(day));
    const entries = getWeek(ws, false)?.[day]?.[meal] || [];
    const ref = fb.doc(col('slots'), slotId(date, meal));
    return run(entries.length ? fb.setDoc(ref, { date, meal, entries }) : fb.deleteDoc(ref));
  };
  self.saveWeek = ws => run(commitInChunks(slotOps(state.schedules, ws), 400));
  self.saveAllSlots = () => run(commitInChunks(slotOps(state.schedules), 400));
  self.saveAllDishes = removedIds => run(commitInChunks([
    ...state.dishes.map(d => b => b.set(fb.doc(col('dishes'), d.id), dishData(d))),
    ...removedIds.map(id => b => b.delete(fb.doc(col('dishes'), id))),
  ], 20));

  // Grocery edits touch single fields, so two people shopping at once don't overwrite each other.
  self.setHave = (ws, keys) => {
    const have = getGrocery(ws).have;
    const fields = {};
    for (const k of keys) fields[k] = have[k] ? true : fb.deleteField();
    return run(fb.setDoc(groceryRef(ws), { have: fields }, { merge: true }));
  };
  self.saveItemStore = name => {
    const id = state.itemStores[name];
    return run(fb.setDoc(storesRef(), { items: { [name]: id || fb.deleteField() } }, { merge: true }));
  };
  self.saveExtra = (ws, e) =>
    run(fb.setDoc(groceryRef(ws), { extras: { [e.id]: { name: e.name, checked: !!e.checked, at: e.at } } }, { merge: true }));
  self.removeExtra = (ws, id) =>
    run(fb.setDoc(groceryRef(ws), { extras: { [id]: fb.deleteField() } }, { merge: true }));
  self.saveGrocery = ws => run(fb.setDoc(groceryRef(ws), groceryData(getGrocery(ws))));

  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);

  return self;
})();
