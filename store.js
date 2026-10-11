'use strict';

// Key-value persistence. Uses IndexedDB (room for many photos); falls back to
// localStorage if IndexedDB is unavailable (e.g. some browsers on file://).
const Store = (() => {
  const DB_NAME = 'family-meals';
  const STORE = 'kv';
  const LS_PREFIX = 'fm-data-';
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('no indexedDB'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(() => null);
    }
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async function get(key, fallback) {
    const db = await openDb();
    if (db) {
      const v = await tx(db, 'readonly', s => s.get(key));
      return v === undefined ? fallback : v;
    }
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  }

  async function set(key, value) {
    const db = await openDb();
    if (db) return tx(db, 'readwrite', s => s.put(value, key));
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  }

  return { get, set };
})();
