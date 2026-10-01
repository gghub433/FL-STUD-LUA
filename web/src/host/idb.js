// Small IndexedDB key-value wrapper: stores "samples", "projects", "backups", "kv".
const DB_NAME = 'stepwise-daw';
const STORES = ['samples', 'projects', 'backups', 'kv'];
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
export const idbPut = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)).then(() => true).catch(() => false);
export const idbDelete = (store, key) => tx(store, 'readwrite', (s) => s.delete(key)).then(() => true).catch(() => false);
export const idbKeys = (store) => tx(store, 'readonly', (s) => s.getAllKeys()).catch(() => []);
export const idbAll = (store) => open().then((db) => new Promise((resolve) => {
  const out = [];
  const t = db.transaction(store, 'readonly');
  const req = t.objectStore(store).openCursor();
  req.onsuccess = () => {
    const c = req.result;
    if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out);
  };
  req.onerror = () => resolve(out);
})).catch(() => []);
