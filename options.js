// The one page with a user gesture in it, which is what the folder picker and a permission
// re-grant both need. Opened by the worker with ?resume=<id> when a cutting is parked waiting
// for a folder; finishing that save is the first thing it does once one is chosen.
import { getSettings, setSettings, getDir, setDir, dirState } from './sink.js';

const $ = (s) => document.querySelector(s);
const resume = new URLSearchParams(location.search).get('resume');
const status = (text, kind = '') => { $('#status').textContent = text; $('#status').className = 'status ' + kind; };

async function paint() {
  const { sink } = await getSettings();
  $(`input[value="${sink}"]`).checked = true;
  const d = await dirState();
  $('#dir').textContent = d.name ? d.name + '/' : '';
  $('#regrant').hidden = d.state !== 'prompt';
  $('#choose').textContent = d.name ? 'Change folder…' : 'Choose folder…';
  $('#pending').hidden = !resume;
}

async function finish() {
  if (!resume) return;
  const res = await chrome.runtime.sendMessage({ type: 'saveParked', id: resume });
  if (!res || res.error) return status(res?.error || 'Not saved', 'err');
  status(`Cut. Saved as ${res.name}.md`, 'ok');
  $('#pending').hidden = true;
  history.replaceState(null, '', location.pathname);
}

$('#choose').addEventListener('click', async () => {
  try {
    const h = await showDirectoryPicker({ mode: 'readwrite', id: 'cuttings' });
    await setDir(h);
    await setSettings({ sink: 'folder' });
    await paint();
    status(`Cuttings land in ${h.name}/`, 'ok');
    await finish();
  } catch (e) { if (e.name !== 'AbortError') status(e.message, 'err'); }
});

$('#regrant').addEventListener('click', async () => {
  const h = await getDir();
  const p = await h.requestPermission({ mode: 'readwrite' });
  await paint();
  if (p === 'granted') { status(`Cuttings land in ${h.name}/`, 'ok'); await finish(); }
  else status('Access wasn’t granted', 'err');
});

for (const r of document.querySelectorAll('input[name="sink"]')) {
  r.addEventListener('change', async () => {
    await setSettings({ sink: r.value });
    status(r.value === 'vault' ? 'Cuttings post to the vault reader' : 'Cuttings land in a folder');
    if (r.value === 'vault') await finish();
  });
}

paint();
