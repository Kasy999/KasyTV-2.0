/**
 * IndexedDB storage for the large / structured data:
 *  - "kv": favourites, history, resume positions, settings mirror, caches
 *  - "playlists": parsed IPTV playlists ({ id, channels, groups, epgUrls, updatedAt })
 * Falls back to memory when IndexedDB is unavailable (some private modes), so the app still runs.
 */
const DB_NAME = 'kasy-tv';
const DB_VERSION = 1;
const STORES = ['kv', 'playlists'];

let dbPromise = null;
const memory = { kv: new Map(), playlists: new Map() };
let useMemory = false;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in window)) {
      useMemory = true;
      resolve(null);
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      useMemory = true;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      console.warn('[db] IndexedDB nicht verfügbar – Speicher nur im Arbeitsspeicher');
      useMemory = true;
      resolve(null);
    };
    req.onblocked = () => console.warn('[db] blockiert');
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db || useMemory) return fn(null, memory[store]);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    Promise.resolve(fn(os, null)).then((r) => (result = r), reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  get(key) {
    return tx('kv', 'readonly', (os, mem) => (mem ? mem.get(key) : wrap(os.get(key))));
  },
  set(key, value) {
    return tx('kv', 'readwrite', (os, mem) => (mem ? mem.set(key, value) : wrap(os.put(value, key))));
  },
  del(key) {
    return tx('kv', 'readwrite', (os, mem) => (mem ? mem.delete(key) : wrap(os.delete(key))));
  },
  async entries() {
    return tx('kv', 'readonly', async (os, mem) => {
      if (mem) return Array.from(mem.entries());
      const [keys, values] = await Promise.all([wrap(os.getAllKeys()), wrap(os.getAll())]);
      return keys.map((k, i) => [k, values[i]]);
    });
  },
  playlistGet(id) {
    return tx('playlists', 'readonly', (os, mem) => (mem ? mem.get(id) : wrap(os.get(id))));
  },
  playlistPut(pl) {
    return tx('playlists', 'readwrite', (os, mem) => (mem ? mem.set(pl.id, pl) : wrap(os.put(pl))));
  },
  playlistDel(id) {
    return tx('playlists', 'readwrite', (os, mem) => (mem ? mem.delete(id) : wrap(os.delete(id))));
  },
  playlistAll() {
    return tx('playlists', 'readonly', (os, mem) => (mem ? Array.from(mem.values()) : wrap(os.getAll())));
  },
  async clearAll() {
    for (const s of STORES) await tx(s, 'readwrite', (os, mem) => (mem ? mem.clear() : wrap(os.clear())));
  },
  get isMemoryOnly() {
    return useMemory;
  },
  open,
};

/** Asks the browser not to evict our data (Safari/Chrome grant it for installed PWAs). */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function storageInfo() {
  const info = { persisted: false, usage: null, quota: null };
  try {
    if (navigator.storage) {
      if (navigator.storage.persisted) info.persisted = await navigator.storage.persisted();
      if (navigator.storage.estimate) Object.assign(info, await navigator.storage.estimate());
    }
  } catch {
    /* ignore */
  }
  return info;
}
