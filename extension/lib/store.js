/* Dauerhafter Speicher (IndexedDB) für Download-Aufträge und bereits geladene Stream-Teile.
 * So können abgebrochene Downloads auch nach einem Firefox-Neustart an derselben Stelle weiterlaufen. */
(function (g) {
  'use strict';
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('vdl', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('parts')) d.createObjectStore('parts');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { dbp = null; reject(r.error); };
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Speichern abgebrochen'));
    });
  }
  const range = id => IDBKeyRange.bound(id + '|', id + '|￿');
  const partKey = (id, track, i) => id + '|' + track + '|' + String(i).padStart(7, '0');

  g.VDLStore = {
    partKey,
    putJob: job => tx('jobs', 'readwrite', s => s.put(job)),
    allJobs: () => tx('jobs', 'readonly', s => s.getAll()),
    deleteJob: id => tx('jobs', 'readwrite', s => s.delete(id)),
    putPart: (id, track, i, blob) => tx('parts', 'readwrite', s => s.put(blob, partKey(id, track, i))),
    partKeys: id => tx('parts', 'readonly', s => s.getAllKeys(range(id))),
    getPart: key => tx('parts', 'readonly', s => s.get(key)),
    deleteParts: id => tx('parts', 'readwrite', s => s.delete(range(id)))
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
