// Everything a reader owns lives on their own device: the file bytes in
// IndexedDB, the checkpoint next to them. Nothing is uploaded anywhere.

const DB_NAME = "slate";
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("marks")) db.createObjectStore("marks", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/** A document is identified by its contents, so the same PDF reopened from
 *  a different folder still finds its checkpoint. */
export async function fingerprint(file) {
  const buf = await file.arrayBuffer();
  // crypto.subtle exists only in a secure context. Served over plain http from
  // a LAN address it is simply missing, and a reader should still open there.
  const id = globalThis.crypto?.subtle
    ? await sha256(buf)
    : sampledHash(buf, file.size);
  return { id, buf };
}

async function sha256(buf) {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** FNV-1a over the head and tail of the file plus its length. Not a checksum —
 *  just enough to tell one document on the shelf from another. */
function sampledHash(buf, size) {
  const bytes = new Uint8Array(buf);
  const window = 262144;
  const head = bytes.subarray(0, window);
  const tail = bytes.subarray(Math.max(bytes.length - window, 0));
  let hash = 0x811c9dc5;
  for (const chunk of [head, tail]) {
    for (let i = 0; i < chunk.length; i++) {
      hash ^= chunk[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `s${hash.toString(16)}${size.toString(16)}`;
}

export function putDoc(doc) {
  return run("docs", "readwrite", s => s.put(doc));
}

export function getDoc(id) {
  return run("docs", "readonly", s => s.get(id));
}

export function allDocs() {
  return run("docs", "readonly", s => s.getAll()).then(rows =>
    rows.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
  );
}

export function removeDoc(id) {
  return Promise.all([
    run("docs", "readwrite", s => s.delete(id)),
    run("marks", "readwrite", s => s.delete(id))
  ]);
}

export function getMarks(id) {
  return run("marks", "readonly", s => s.get(id)).then(row => row?.list || []);
}

export function putMarks(id, list) {
  return run("marks", "readwrite", s => s.put({ id, list }));
}

/** The checkpoint. Written often, so it stays in localStorage where a write
 *  is synchronous and survives the tab being closed mid-sentence. */
export function saveCheckpoint(id, point) {
  try {
    localStorage.setItem(`slate:at:${id}`, JSON.stringify({ ...point, at: Date.now() }));
  } catch { /* private mode, or the quota is full; reading still works */ }
}

export function loadCheckpoint(id) {
  try {
    return JSON.parse(localStorage.getItem(`slate:at:${id}`) || "null");
  } catch {
    return null;
  }
}

export function savePrefs(prefs) {
  try { localStorage.setItem("slate:prefs", JSON.stringify(prefs)); } catch { /* ignore */ }
}

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem("slate:prefs") || "null") || {};
  } catch {
    return {};
  }
}
