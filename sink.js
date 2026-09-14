// Where a cutting lands. Two sinks, one setting: `folder` writes the files straight into a
// directory the user picked once (the File System Access handle lives in IndexedDB, which is the
// only place a handle survives); `vault` posts the payload to the vault reader on localhost, which
// renders the same note. A fresh install defaults to `folder` and never mentions a vault.
import { renderCutting } from './render.js';

export const VAULT_URL = 'http://localhost:4700';
const DB = 'cuttings', STORE = 'handles', KEY = 'dir';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result); tx.onerror = () => reject(tx.error);
  });
}
async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}

export const getSettings = async () => ({ sink: 'folder', ...(await chrome.storage.local.get('settings')).settings });
export const setSettings = async (patch) => chrome.storage.local.set({ settings: { ...(await getSettings()), ...patch } });

export const getDir = () => idbGet(KEY);
export const setDir = (handle) => idbSet(KEY, handle);

// 'granted' | 'prompt' | 'none'. After a browser restart the handle is still there but may need
// its permission re-asked, which only a page with a user gesture can do — not this worker.
export async function dirState() {
  const h = await getDir();
  if (!h) return { state: 'none' };
  try { return { state: await h.queryPermission({ mode: 'readwrite' }), name: h.name }; }
  catch { return { state: 'prompt', name: h.name }; }
}

async function writeFile(dir, path, blob) {
  const parts = path.split('/');
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const f = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await f.createWritable();
  await w.write(blob);
  await w.close();
}

// Returns { name, title } on success, or throws. Throws { needsFolder: true } when the folder is
// missing or wants its permission re-granted — the caller parks the cutting and opens the options
// page, which finishes the job.
export async function save(c) {
  const { sink } = await getSettings();
  if (sink === 'vault') {
    const r = await fetch(VAULT_URL + '/cuttings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c),
    }).catch(() => { throw new Error('Vault reader isn’t running (localhost:4700)'); });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  const dir = await getDir();
  if (!dir) throw Object.assign(new Error('Choose a folder for cuttings first'), { needsFolder: true });
  if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    throw Object.assign(new Error('Cuttings needs the folder again'), { needsFolder: true });
  }
  const { name, title, files } = renderCutting(c);
  for (const f of files) {
    const blob = f.text != null ? new Blob([f.text], { type: 'text/markdown' }) : await (await fetch(f.dataUrl)).blob();
    await writeFile(dir, f.path, blob);
  }
  return { name, title };
}
