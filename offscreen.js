// Cuttings — offscreen document. Owns the recorder.
//
// The tab can only be captured whole, so each frame is drawn into a canvas cropped to the selected
// element and *that* canvas is what gets recorded. Two things fall out of it: the clip is the
// specimen rather than a picture of a browser window, and every mark this extension draws — which
// all lives outside the element's rect — is cropped away, which is what lets the recording
// indicator be as loud as it needs to be.
//
// The draw loop is a setInterval, not requestAnimationFrame: an offscreen document is never
// rendered, so rAF does not fire here.

const MAX_MS = 20000;
const FPS = 30;
const MIME = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  .find((m) => MediaRecorder.isTypeSupported(m));

let take = null;

function teardown() {
  if (!take) return;
  clearInterval(take.timer); clearTimeout(take.cap);
  try { take.rec.state !== 'inactive' && take.rec.stop(); } catch {}
  take.stream?.getTracks().forEach((t) => t.stop());
  take.video?.remove();
  take = null;
}

async function start(tabId, streamId, rect, vw) {
  teardown();
  if (!MIME) throw new Error('this Chrome records no webm');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: FPS } },
  });

  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  document.body.appendChild(video);
  await video.play();
  await new Promise((res) => (video.videoWidth ? res() : (video.onloadedmetadata = res)));

  // The page measures in CSS pixels; the captured frame is in device pixels. Derive the scale from
  // the frame itself rather than trusting the page's devicePixelRatio.
  const scale = video.videoWidth / (vw || video.videoWidth);
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.max(2, Math.min(video.videoWidth - sx, Math.round(rect.w * scale)));
  const sh = Math.max(2, Math.min(video.videoHeight - sy, Math.round(rect.h * scale)));

  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d', { alpha: false });

  const t = { tabId, stream, video, canvas, ctx, sx, sy, sw, sh, chunks: [], poster: null, full: null, started: Date.now() };

  const draw = () => {
    try {
      ctx.drawImage(video, t.sx, t.sy, t.sw, t.sh, 0, 0, sw, sh);
      if (!t.poster) {
        t.poster = canvas.toDataURL('image/png');
        const f = document.createElement('canvas');
        f.width = Math.min(1280, video.videoWidth);
        f.height = Math.round(video.videoHeight * (f.width / video.videoWidth));
        f.getContext('2d').drawImage(video, 0, 0, f.width, f.height);
        t.full = f.toDataURL('image/jpeg', 0.72);   // context only, so it needn't be lossless
      }
    } catch {}
  };
  draw();

  const out = canvas.captureStream(FPS);
  const rec = new MediaRecorder(out, { mimeType: MIME, videoBitsPerSecond: 2_500_000 });
  rec.ondataavailable = (e) => { if (e.data.size) t.chunks.push(e.data); };
  rec.start();
  t.rec = rec;
  t.timer = setInterval(draw, Math.round(1000 / FPS));
  // Hard backstop. The content script also counts, but a wedged page must not record forever.
  t.cap = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'autostop', tabId }).catch(() => {});
  }, MAX_MS + 500);

  // The stream can die under us — the tab closes, or Chrome's "stop sharing" is pressed. Finish
  // the take rather than dropping it on the floor.
  stream.getVideoTracks()[0].onended = () => {
    chrome.runtime.sendMessage({ type: 'takeEnded', tabId }).catch(() => {});
  };
  take = t;
  return { ok: true };
}

async function finish(discard) {
  if (!take) return { seconds: 0 };
  const t = take;
  if (discard) { teardown(); return { discarded: true }; }
  const seconds = Math.max(1, Math.round((Date.now() - t.started) / 1000));
  const blob = await new Promise((res) => {
    t.rec.onstop = () => res(new Blob(t.chunks, { type: 'video/webm' }));
    try { t.rec.stop(); } catch { res(new Blob(t.chunks, { type: 'video/webm' })); }
  });
  const poster = t.poster, full = t.full;
  teardown();
  if (!blob.size) return { seconds: 0, error: 'the recording came back empty' };
  const dataUrl = await new Promise((res, rej) => {
    const f = new FileReader();
    f.onload = () => res(f.result); f.onerror = () => rej(new Error('could not read the clip'));
    f.readAsDataURL(blob);
  });
  return { dataUrl, poster, full, seconds };
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.target !== 'offscreen') return;
  (async () => {
    if (msg.type === 'status') return { recording: !!take };
    if (msg.type === 'start') return await start(msg.tabId, msg.streamId, msg.rect, msg.vw);
    if (msg.type === 'finish') return await finish(msg.discard);
    if (msg.type === 'stop') { teardown(); return { ok: true }; }
    return { ok: true };
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});
