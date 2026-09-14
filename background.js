// Cuttings — service worker. Owns the hotkey, the screenshot, and where the cutting lands.
import { save } from './sink.js';
const pending = new Map(); // id → { still, viewport, clip }
const parked = new Map();  // id → the whole cutting, waiting for a folder to be chosen
let seq = 0;

const log = (...a) => console.log('[cuttings]', ...a);
log('service worker up');
chrome.commands.getAll().then((cs) => {
  log('shortcuts:', cs.map((c) => `${c.name}=${c.shortcut || 'UNBOUND'}`).join('  '));
  const loose = cs.filter((c) => !c.shortcut).map((c) => c.name);
  if (loose.length) log('NOT BOUND:', loose.join(', '), '— set them at chrome://extensions/shortcuts');
}).catch(() => {});
const tell = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).then(() => true, () => false);

/* ---------- saying so ---------- */
// Every failure has to arrive somewhere. The toast is the good path; the badge is the fallback
// for when the content script never made it onto the page — which is exactly when things break.
async function badge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {}
}
async function say(tabId, text, err) {
  log(err ? 'ERROR:' : '·', text);
  if (await tell(tabId, { type: 'toast', text, err })) return;
  if (err) { badge(tabId, '!', '#f0329a'); chrome.action.setTitle({ tabId, title: 'Cuttings — ' + text }).catch(() => {}); }
}

async function ensureContent(tabId) {
  if (await tell(tabId, { type: 'ping' })) return true;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (e) { log('could not inject:', e.message); return false; }
}

/* ---------- offscreen document: holds the rolling recorders ---------- */
let creating = null;
async function offscreen() {
  const has = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (has.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA'],
      justification: 'Rolling buffer of the tab, so motion can be captured after it happens.',
    }).catch((e) => { if (!/single offscreen|already exists/i.test(e.message)) throw e; });
  }
  try { await creating; } finally { creating = null; }
}

// createDocument resolves a beat before the document's onMessage listener is registered, and a
// message sent into that gap rejects with "Receiving end does not exist". Retry instead of
// losing the keypress — this is what made the first ⌥⇧M of a session do nothing at all.
const GAP = /Receiving end does not exist|Could not establish connection|message port closed/i;
async function ask(msg, tries = 10) {
  await offscreen();
  for (let i = 0; ; i++) {
    try { return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg }); }
    catch (e) {
      if (i >= tries - 1 || !GAP.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 60));
      await offscreen();
    }
  }
}

const watching = async (tabId) => (await ask({ type: 'status', tabId }))?.watching;

// getMediaStreamId must be called while the user's keypress is still live — synchronously, before
// the first await. Everything downstream can be async; this one call cannot wait, or Chrome answers
// "Extension has not been invoked for the current page". So the handler claims the stream up front
// and passes the pending handle down.
// The stream handle must be claimed while the keypress is still live, but the take doesn't begin
// until ⇧click — so the handle is claimed on ⌥C and held for the tab until it's used or replaced.
const handles = new Map();   // tabId → { id, p }
let lastTabId = null;
chrome.tabs.onActivated.addListener(({ tabId }) => { lastTabId = tabId; });

function claimStream(tab) {
  const id = tab?.id ?? lastTabId;
  if (id == null) return null;
  try { return { id, p: chrome.tabCapture.getMediaStreamId({ targetTabId: id }).catch((e) => ({ err: e.message })) }; }
  catch (e) { return { id, p: Promise.resolve({ err: e.message }) }; }
}

async function beginTake(tabId, rect, vw) {
  const h = handles.get(tabId);
  if (!h) throw new Error('no capture handle — press ⌥C again on this tab');
  if (h.id !== tabId) throw new Error('that handle belonged to another tab — press ⌥C again');
  const streamId = await h.p;
  if (streamId?.err) { handles.delete(tabId); throw new Error(streamId.err); }
  const res = await ask({ type: 'start', tabId, streamId, rect, vw });
  if (res?.error) { handles.delete(tabId); throw new Error(res.error); }
  handles.delete(tabId);          // a stream id is single-use
  return res;
}

/* ---------- commands ---------- */
// Two controls, two meanings. ⌥C takes a still; ⌥⇧M arms the buffer. Cutting used to arm the
// buffer behind your back so motion was "just there" — but that collapsed both keys into one
// implicit behaviour, and you could no longer tell what a cut would produce before taking it.
// Motion is now only ever recorded because you asked for it.
async function pick(tab) {
  if (!(await ensureContent(tab.id))) return say(tab.id, 'Cuttings can’t reach this page.', true);
  tell(tab.id, { type: 'pick' });
}

// Deliberately not async: the stream must be claimed in the same synchronous turn as the keypress.
chrome.commands.onCommand.addListener((cmd, tab) => {
  const stream = claimStream(tab);          // first, before anything can await
  if (stream) handles.set(stream.id, stream);
  log('command', cmd, 'tab', tab?.id ?? '(none given)', tab?.url ? '' : '(no url)');
  run(cmd, tab, stream);
});
chrome.action.onClicked.addListener((tab) => {
  const stream = claimStream(tab);
  if (stream) handles.set(stream.id, stream);
  run('cut', tab, stream);
});

// A third route that can't be taken away by a shortcut conflict — and right-clicking is itself a
// user invocation, so it grants activeTab the same way the keypress does.
const MENU = { cut: 'Take a cutting' };
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of Object.entries(MENU)) {
      chrome.contextMenus.create({ id, title, contexts: ['page', 'image', 'video', 'selection', 'link'] });
    }
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const stream = claimStream(tab);
  if (stream) handles.set(stream.id, stream);
  run('cut', tab, stream);
});

async function run(cmd, tab, stream) {
  // onCommand has handed over the tab since Chrome 89, but recover rather than die quietly if not.
  if (!tab) tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) return log('no tab for', cmd);
  // Bail only when the URL is positively known to be uncapturable. An empty url means the tab just
  // hasn't told us yet — press on and let the real call produce a real error, rather than nothing.
  const url = tab.url || '';
  if (url && !/^https?:/.test(url)) { badge(tab.id, '!', '#f0329a'); return log('not an http(s) page:', url); }
  if (cmd === 'cut') return pick(tab);
  log('unknown command', cmd);
}

/* ---------- pixels ---------- */
// Trust the pixels, not the reported devicePixelRatio: browser zoom, a second monitor, or Chrome's
// own capture cap can all make captureVisibleTab hand back a different scale than the page thinks.
async function crop(dataUrl, rect, viewport) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bmp.width / (viewport?.w || bmp.width);
  const x = Math.max(0, rect.x * scale), y = Math.max(0, rect.y * scale);
  const w = Math.min(bmp.width - x, rect.w * scale), h = Math.min(bmp.height - y, rect.h * scale);
  // A sliver means the pick went wrong or the element ran off the fold; the whole viewport is
  // a more honest record than a 10:1 band of nothing.
  if (w < 8 || h < 8) return null;
  const c = new OffscreenCanvas(Math.round(w), Math.round(h));
  c.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, c.width, c.height);
  const buf = await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
  return 'data:image/png;base64,' + b64(buf);
}
function b64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Slices of a full-height capture, held here rather than in the page so a long document doesn't
// balloon the tab's memory. Keyed by capture, dropped the moment they're stitched.
const slices = new Map();

// A take belongs to the tab, not to the document. tabCapture keeps rolling straight through a
// navigation, but the content script does not survive one — so everything needed to finish and
// write the cutting is held here from the moment recording starts. `ready` parks a finished take
// until a content script turns up to show the card, which is what happens when a click during
// recording navigates the page out from under us.
const takes = new Map();    // tabId → { rect, vw, measure, page, startedAt }
const ready = new Map();    // tabId → { id, clipSeconds, measure }

async function finishTake(tabId, discard) {
  const t = takes.get(tabId);
  takes.delete(tabId);
  badge(tabId, '');
  const out = await ask({ type: 'finish', discard: !!discard });
  if (discard || out?.discarded) return { ok: true };
  if (out?.error) throw new Error(out.error);
  if (!out?.dataUrl) throw new Error('nothing was recorded');
  const id = `${Date.now()}-${++seq}`;
  pending.set(id, {
    still: out.poster, viewport: out.full, clip: out.dataUrl, seconds: out.seconds,
    measure: t?.measure, page: t?.page,          // the page it came from, not wherever we ended up
  });
  return { id, clipSeconds: out.seconds, measure: t?.measure };
}


chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'offscreen') return;
  if (msg.type === 'autostop' || msg.type === 'takeEnded') {
    const t = msg.tabId;
    if (takes.has(t)) {
      finishTake(t, false)
        .then((res) => { if (res.id) { ready.set(t, res); tell(t, { type: 'takeReady', ...res }); } })
        .catch((e) => log('could not finish take:', e.message));
    }
    reply?.({ ok: true });
    return;
  }
  const tabId = sender.tab?.id;

  if (msg.type === 'freeze') {
    (async () => {
      const id = `${Date.now()}-${++seq}`;
      const viewport = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      const still = await crop(viewport, msg.measure.rect, msg.measure.viewport);
      pending.set(id, { still, viewport, clip: null });
      reply({ id, clipSeconds: 0 });
    })().catch((e) => reply({ error: e.message }));
    return true;
  }
  if (msg.type === 'slice') {
    (async () => {
      const shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      const arr = slices.get(msg.capId) || [];
      arr.push({ sx: msg.sx, sy: msg.sy, dataUrl: shot });
      slices.set(msg.capId, arr);
      badge(tabId, String(arr.length), '#111111');
      reply({ ok: true, n: arr.length });
    })().catch((e) => reply({ error: e.message }));
    return true;
  }
  if (msg.type === 'stitchFull') {
    (async () => {
      badge(tabId, '');
      const arr = slices.get(msg.capId) || [];
      slices.delete(msg.capId);
      if (!arr.length) throw new Error('nothing was captured');

      const first = await createImageBitmap(await (await fetch(arr[0].dataUrl)).blob());
      const scale = first.width / msg.vw;                 // trust the pixels, not the reported dpr
      const W = msg.doc.w * scale, H = msg.doc.h * scale;
      // A tall page can run to hundreds of megapixels; keep it inside a sane budget.
      const k = Math.min(1, Math.sqrt(40e6 / Math.max(1, W * H)));
      const c = new OffscreenCanvas(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)));
      const ctx = c.getContext('2d');
      for (const s of arr) {
        const bmp = s === arr[0] ? first : await createImageBitmap(await (await fetch(s.dataUrl)).blob());
        ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height,
          (s.sx - msg.doc.x) * scale * k, (s.sy - msg.doc.y) * scale * k, bmp.width * k, bmp.height * k);
      }
      // PNG for anything screenshot-sized; a long page is photographic in bulk, so JPEG it.
      const big = c.width * c.height > 4e6;
      const blob = await c.convertToBlob(big ? { type: 'image/jpeg', quality: 0.86 } : { type: 'image/png' });
      const still = `data:${blob.type};base64,` + b64(await blob.arrayBuffer());

      const v = new OffscreenCanvas(Math.min(1280, first.width), Math.round(first.height * (Math.min(1280, first.width) / first.width)));
      v.getContext('2d').drawImage(first, 0, 0, v.width, v.height);
      const vb = await v.convertToBlob({ type: 'image/jpeg', quality: 0.72 });

      const id = `${Date.now()}-${++seq}`;
      pending.set(id, { still, viewport: 'data:image/jpeg;base64,' + b64(await vb.arrayBuffer()), clip: null });
      reply({ id, clipSeconds: 0, slices: arr.length });
    })().catch((e) => reply({ error: e.message }));
    return true;
  }
  if (msg.type === 'record') {
    beginTake(tabId, msg.rect, msg.vw)
      .then(() => {
        takes.set(tabId, { rect: msg.rect, vw: msg.vw, measure: msg.measure, page: msg.page, startedAt: Date.now() });
        badge(tabId, '●', '#ff3b30');
        chrome.action.setTitle({ tabId, title: 'Cuttings — recording' }).catch(() => {});
        reply({ ok: true });
      })
      .catch((e) => reply({ error: e.message }));
    return true;
  }
  // A fresh content script announces itself: mid-take, restore the frame; take already finished
  // while the page was navigating, hand it the card.
  if (msg.type === 'hello') {
    const t = takes.get(tabId);
    if (t) return reply({ recording: true, rect: t.rect, startedAt: t.startedAt, element: t.measure?.element });
    const r = ready.get(tabId);
    if (r) { ready.delete(tabId); return reply({ takeReady: r }); }
    return reply({});
  }
  if (msg.type === 'stopRecord') {
    finishTake(tabId, msg.discard).then(reply).catch((e) => reply({ error: e.message }));
    return true;
  }
  if (msg.type === 'discard') { pending.delete(msg.id); reply({ ok: true }); }
  if (msg.type === 'save') {
    (async () => {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (!p) throw new Error('That moment is gone');
      const c = { ...p, note: msg.note, folder: msg.folder, page: p.page || msg.page, measure: p.measure || msg.measure };
      try { reply(await save(c)); }
      catch (e) {
        if (!e.needsFolder) throw e;
        // No folder yet, or its permission lapsed with the browser restart. Neither can be fixed
        // from here — a picker needs a page and a gesture — so park the cutting and open the one
        // page that has both. It finishes the save.
        parked.set(msg.id, c);
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html?resume=' + encodeURIComponent(msg.id)) });
        reply({ parked: true, message: e.message });
      }
    })().catch((e) => reply({ error: e.message }));
    return true;
  }
  if (msg.type === 'saveParked') {
    (async () => {
      const c = parked.get(msg.id);
      if (!c) throw new Error('That cutting is gone — the worker was restarted');
      const res = await save(c);
      parked.delete(msg.id);
      reply(res);
    })().catch((e) => reply({ error: e.message }));
    return true;
  }
});

// A click during a take can navigate the page out from under the overlay. tabCapture keeps
// rolling — it is bound to the tab, not the document — so the only thing lost is the UI. Put it
// back as soon as the new document is ready, and hand over any take that finished in between.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const t = takes.get(tabId), r = ready.get(tabId);
  if (!t && !r) return;
  if (!(await ensureContent(tabId))) return;
  if (t) return void tell(tabId, { type: 'resume', rect: t.rect, startedAt: t.startedAt, element: t.measure?.element });
  ready.delete(tabId);
  tell(tabId, { type: 'takeReady', ...r });
});

// A click during a take can open a new tab instead of navigating. tabCapture is bound to one tab,
// so the take stays where it started — which is correct, but silently confusing if you followed the
// link. Say so, rather than letting the timer run on a page nobody is looking at.
chrome.tabs.onCreated.addListener((tab) => {
  const from = tab.openerTabId;
  if (from == null || !takes.has(from)) return;
  tell(from, { type: 'toast', text: 'That opened a new tab — the take is still on this page.' });
  chrome.action.setTitle({ tabId: from, title: 'Cuttings — still recording this tab' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handles.delete(tabId); takes.delete(tabId); ready.delete(tabId);
  ask({ type: 'stop', tabId }).catch(() => {});
});
