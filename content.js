// Cuttings — content script. The picker: hover outlines, click freezes the moment, then you type.
// The still and the motion clip are taken at the click, before the note field opens, so nothing
// changes on the page while you're finding the words.
(() => {
  // Reloading the extension orphans the copy of this script already in the page: its listeners are
  // dead but `window.__cuttings` survives. A plain `if (already) return` guard therefore made every
  // fresh injection no-op, and the page ended up with a dead script and no live one — the shortcuts
  // went quiet until the tab was reloaded. So retire the previous instance instead of yielding to it.
  try { window.__cuttings?.retire?.(); } catch {}

  // An orphan — a copy left behind by an extension reload — keeps its document listeners and throws
  // "Extension context invalidated" the moment it touches chrome.*. It can't be reached by a message,
  // so it has to notice on its own: chrome.runtime.id goes undefined when the context dies.
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  function send(msg, cb) {
    if (!alive()) { retire(); return false; }
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { cb?.(null); return; }
        cb?.(res);
      });
      return true;
    } catch { retire(); return false; }
  }

  let picking = false, box = null, tag = null, current = null, card = null, watchDot = null, retired = false;
  let recording = false, recEl = null, recRect = null, recStart = 0, recTick = null, recName = '';
  const MAX_MS = 20000;   // safety cap — a clip is a specimen, not footage

  const label = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    return el.tagName.toLowerCase() + id + cls;
  };

  /* ---------- measuring ---------- */
  const DEFAULTS = new Set(['none', 'normal', '0px', 'auto', 'rgba(0, 0, 0, 0)', 'transparent', 'all 0s ease 0s', 'all', 'visible', 'static', '0s']);
  const KEYS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'color', 'background-color', 'background-image',
    'border-radius', 'padding', 'margin', 'gap', 'opacity', 'transform', 'transition', 'animation', 'mix-blend-mode', 'backdrop-filter', 'box-shadow', 'filter', 'clip-path'];

  const hex = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
    if (!m) return null;
    if (m[4] !== undefined && +m[4] === 0) return null;
    return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
  };

  function measure(el) {
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of KEYS) {
      const v = cs.getPropertyValue(k).trim();
      if (v && !DEFAULTS.has(v) && !(k === 'background-image' && v === 'none')) styles[k] = v;
    }
    // Motion: the element itself, then ancestors — the thing that moves is often the wrapper.
    const motion = [];
    let node = el, depth = 0;
    while (node && node !== document.body && depth < 8) {
      const s = getComputedStyle(node);
      const t = s.transition, a = s.animationName;
      if ((t && !DEFAULTS.has(t)) || (a && a !== 'none')) {
        motion.push({ on: label(node), transition: DEFAULTS.has(t) ? null : t, animation: a === 'none' ? null : `${a} ${s.animationDuration} ${s.animationTimingFunction} ${s.animationIterationCount}` });
      }
      node = node.parentElement; depth++;
    }
    // Palette and type inside the subtree.
    const colors = new Map(), fonts = new Map();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let n = el, count = 0;
    while (n && count < 400) {
      const s = getComputedStyle(n);
      for (const c of [hex(s.color), hex(s.backgroundColor)]) if (c) colors.set(c, (colors.get(c) || 0) + 1);
      if (n.innerText && n.childElementCount === 0) {
        const f = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        const key = `${f} ${s.fontWeight} · ${s.fontSize}/${s.lineHeight}`;
        fonts.set(key, (fonts.get(key) || 0) + 1);
      }
      n = walker.nextNode(); count++;
    }
    const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map((x) => x[0]);
    const r = el.getBoundingClientRect();
    // A <canvas> has nothing to measure: the type, colour and motion all live in the shader.
    // Say so on the note rather than printing an empty "Measured" section.
    const cv = el.tagName === 'CANVAS' ? el : el.querySelector('canvas');
    const surface = cv && cv.getBoundingClientRect().width * cv.getBoundingClientRect().height > r.width * r.height * 0.5
      ? { kind: 'canvas', w: cv.width, h: cv.height }
      : null;
    return {
      element: label(el),
      surface,
      text: (el.innerText || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      styles, motion, palette: top(colors, 6), fonts: top(fonts, 4),
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      scroll: { x: scrollX, y: scrollY },
    };
  }

  // The live readout on the hover tag: type on one line, spacing on the next. Reads off every
  // element as the cursor moves, so the picker doubles as an inspector even when nothing is cut.
  const px = (v) => v.replace(/px/g, '').replace(/(^|\s)0(?=\s|$)/g, '$10').trim();
  const allZero = (v) => /^(0px\s*)+$/.test(v);
  function readout(el) {
    const s = getComputedStyle(el);
    const lines = [];
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || (el.innerText || '').trim();
    if (hasText) {
      const fam = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const lh = s.lineHeight === 'normal' ? '' : '/' + px(s.lineHeight);
      const ls = s.letterSpacing === 'normal' ? '' : ' · ' + px(s.letterSpacing) + 'px';
      const tt = s.textTransform !== 'none' ? ' · ' + s.textTransform : '';
      lines.push(`<span class="ct-type">${esc(fam)} ${s.fontWeight} · ${px(s.fontSize)}${lh}${ls}${tt}</span>`);
    }
    const sp = [];
    if (!allZero(s.padding)) sp.push(`pad ${px(s.padding)}`);
    if (!allZero(s.margin)) sp.push(`mar ${px(s.margin)}`);
    if (s.gap && s.gap !== 'normal' && !allZero(s.gap)) sp.push(`gap ${px(s.gap)}`);
    if (!allZero(s.borderRadius)) sp.push(`r ${px(s.borderRadius)}`);
    if (sp.length) lines.push(`<span class="ct-space">${esc(sp.join(' · '))}</span>`);
    return lines.map((l) => `<div class="ct-read">${l}</div>`).join('');
  }

  /* ---------- picker ---------- */
  // elementFromPoint returns whatever is topmost, which on a layered site is usually an invisible
  // wrapper — you aim at the artwork and select the sheet of glass in front of it. So walk the whole
  // stack under the cursor and take the first thing that actually paints. ↑/↓ overrides by hand.
  const PAINTS = /^(CANVAS|IMG|VIDEO|SVG|PICTURE|INPUT|BUTTON|SELECT|TEXTAREA)$/;
  function paints(el) {
    if (PAINTS.test(el.tagName)) return true;
    const s = getComputedStyle(el);
    if (s.backgroundImage !== 'none') return true;
    if (!/^rgba\(.*,\s*0\)$|^transparent$/.test(s.backgroundColor)) return true;
    if (s.boxShadow !== 'none' || s.backdropFilter !== 'none') return true;
    if (parseFloat(s.borderTopWidth) || parseFloat(s.borderBottomWidth) || parseFloat(s.borderLeftWidth) || parseFloat(s.borderRightWidth)) return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  }
  const mine = (el) => !!el.classList && [...el.classList].some((c) => c.startsWith('ct-'));

  let base = null, lift = 0;   // base = what the cursor found; lift = how many parents up ↑ has walked

  function resolve() {
    let el = base;
    for (let i = 0; i < lift && el?.parentElement; i++) el = el.parentElement;
    return el;
  }
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function paint() {
    const el = resolve();
    if (!el) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });

    // The spotlight itself is a 100vmax spread shadow on .ct-box (see content.css) — dimming
    // everything else is the one signal that can't be mistaken for a border the page drew.
    const canLift = !!resolve()?.parentElement;
    const fullH = fullHeightOf(el, r);
    const tall = fullH > innerHeight + 4;
    tag.innerHTML =
      `<div class="ct-row">` +
        `<span class="ct-el">${esc(label(el))}</span>` +
        `<span class="ct-size">${Math.round(r.width)} × ${Math.round(r.height)}</span>` +
        (lift ? `<span class="ct-dim">↑${lift}</span>` : '') +
      `</div>` +
      readout(el) +
      (tall ? `<div class="ct-hint ct-tall">${Math.round(fullH)}px tall · ${Math.ceil(fullH / innerHeight)} screens — <kbd>⌥click</kbd> takes all of it</div>` : '') +
      `<div class="ct-hint">${canLift ? '<kbd>↑</kbd><kbd>↓</kbd> adjust · ' : ''}` +
        `<kbd>click</kbd> still · <kbd>⇧click</kbd> record${tall ? ' · <kbd>⌥click</kbd> full' : ''} · ` +
        `<kbd>R</kbd> ${redlines ? '<span class="ct-on">redlines</span>' : 'redlines'} · <kbd>C</kbd> copy · <kbd>esc</kbd> cancel</div>`;

    // Prefer above the selection; drop below when there's no room, and never run off an edge.
    const tw = tag.offsetWidth || 260, th = tag.offsetHeight || 40;
    const above = r.top - th - 8;
    tag.style.top = (above > 4 ? above : Math.min(innerHeight - th - 4, r.bottom + 8)) + 'px';
    tag.style.left = Math.max(4, Math.min(innerWidth - tw - 4, r.left)) + 'px';
  }
  function move(e) {
    if (!alive()) { retire(); return; }
    if (recording) return;                       // the frame is committed; hovering must not move it
    const stack = document.elementsFromPoint(e.clientX, e.clientY).filter((el) => !mine(el));
    // body and html paint on most sites (a background colour), and are never what the cursor meant.
    const root = (el) => el === document.body || el === document.documentElement;
    const found = stack.find((el) => paints(el) && !root(el)) || stack[0];
    if (!found || found === base) return;
    base = found; lift = 0;
    paint();
  }
  function key(e) {
    if (recording) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRecording(true); }
      if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); endRecording(false); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); return; }
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); setRedlines(!redlines); return;
    }
    if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = current || resolve();
      if (el) { e.preventDefault(); e.stopPropagation(); copyAddress(el); }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      const max = (() => { let n = 0, el = base; while (el?.parentElement) { n++; el = el.parentElement; } return n; })();
      lift = Math.max(0, Math.min(max, lift + (e.key === 'ArrowUp' ? 1 : -1)));
      paint();
    }
  }
  function click(e) {
    if (!alive()) { retire(); return; }
    if (recording) {
      // A plain click belongs to the page: most interesting motion is click-triggered, and you
      // have to be able to set it off while the take is running. Only ⇧click closes it.
      if (!e.shiftKey) return;
      e.preventDefault(); e.stopPropagation();
      return endRecording(false);
    }
    e.preventDefault(); e.stopPropagation();
    const el = current || resolve() || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    if (e.shiftKey) return beginRecording(el);
    if (e.altKey) return fullShot(el, { x: e.clientX, y: e.clientY });
    const at = { x: e.clientX, y: e.clientY };
    stop();
    const m = measure(el);
    // Freeze the moment: let a frame paint so our own outline is gone from the shot. But never wait
    // on rAF alone — a hidden or throttled tab fires none, and the cutting would vanish in silence.
    let shot = false;
    const shoot = () => {
      if (shot) return;
      shot = true;
      send({ type: 'freeze', measure: m }, (res) => {
        if (!res || res.error) return toast(res?.error || 'Could not capture', true);
        ask(at, m, res);
      });
    };
    requestAnimationFrame(() => requestAnimationFrame(shoot));
    setTimeout(shoot, 150);
  }
  function start() {
    if (picking || !alive()) return;
    picking = true; current = null; base = null; lift = 0;
    box = document.createElement('div'); box.className = 'ct-box';
    for (const c of ['tl', 'tr', 'bl', 'br']) {
      const k = document.createElement('span'); k.className = 'ct-c ' + c; box.appendChild(k);
    }
    document.documentElement.appendChild(box);
    tag = document.createElement('div'); tag.className = 'ct-tag'; document.documentElement.appendChild(tag);
    document.body.style.cursor = 'crosshair';
    addEventListener('mousemove', move, true);
    addEventListener('click', click, true);
    addEventListener('keydown', key, true);
  }
  function stop() {
    if (!picking) return;
    picking = false;
    setRedlines(false);
    if (recTick) { clearInterval(recTick); recTick = null; }
    box?.remove(); box = null;
    tag?.remove(); tag = null;
    document.body.style.cursor = '';
    removeEventListener('mousemove', move, true);
    removeEventListener('click', click, true);
    removeEventListener('keydown', key, true);
  }

  /* ---------- copy the address ---------- */
  // `C` copies where the hovered element lives, for pasting into a chat: a selector path from the
  // nearest id (or main) down, with :nth-of-type where siblings would otherwise be identical, plus
  // the first few words so a human can check it's the right one. Enough for "change the padding on
  // this" without a screenshot.
  function pathTo(el) {
    const parts = [];
    let n = el, depth = 0;
    while (n && n !== document.body && n !== document.documentElement && depth < 6) {
      let part = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(part + '#' + n.id); break; }
      const cls = [...n.classList].filter((c) => !c.startsWith('ct-')).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((s) => s.tagName === n.tagName && cls.every((c) => s.classList.contains(c)));
        if (same.length > 1) part += `:nth-of-type(${[...p.children].filter((s) => s.tagName === n.tagName).indexOf(n) + 1})`;
      }
      parts.unshift(part);
      if (part === 'main') break;
      n = p; depth++;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }
  function copyAddress(el) {
    const words = (el.innerText || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    const text = pathTo(el) + (words ? `  — "${words}${words.length === 48 ? '…' : ''}"` : '');
    const done = () => toast('Copied ' + pathTo(el));
    const fallback = () => {
      const ta = document.createElement('textarea'); ta.value = text; ta.className = 'ct-clip';
      document.documentElement.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { toast('Could not copy', true); }
      ta.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  /* ---------- redlines ---------- */
  // `R` in the picker stops selecting one thing and annotates everything: every layout block
  // gets a hairline box, a dashed inset where its padding is, and a label with x · width · pad ·
  // gap. Which blocks count is the whole problem: walk down from the page's real container, keep
  // things that are laid out as blocks and are big enough to be layout rather than a word, and
  // only descend into a block that carries no text of its own — a paragraph is a leaf, a column
  // isn't. Capped so a 3,000-node page stays a few hundred boxes.
  let redlines = false, redLayer = null, redTick = 0;
  const RED_DEPTH = 2, RED_MAX = 160, RED_MIN = 40;   // two levels: sections and what's directly in them. Three was rows inside groups inside sections — too many boxes.

  function ownText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  }
  function blockish(el) {
    if (mine(el) || /^(SCRIPT|STYLE|SVG|PATH|BR|WBR|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) return false;
    const s = getComputedStyle(el);
    if (s.display === 'inline' || s.display === 'none' || s.display === 'contents' || s.visibility === 'hidden') return false;
    if (+s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= RED_MIN && r.height >= RED_MIN;
  }
  // body → the first descendant that actually fans out. Sites wrap everything in two or three
  // single-child divs before anything happens; boxing those is noise.
  function pageRoot() {
    let el = document.querySelector('main') || document.body;
    for (let i = 0; i < 6; i++) {
      const kids = [...el.children].filter(blockish);
      if (kids.length !== 1) break;
      el = kids[0];
    }
    return el;
  }
  function sections() {
    const out = [];
    const walk = (el, depth) => {
      for (const kid of el.children) {
        if (out.length >= RED_MAX) return;
        if (!blockish(kid)) continue;
        out.push({ el: kid, depth });
        if (depth < RED_DEPTH && !ownText(kid)) walk(kid, depth + 1);
      }
    };
    walk(pageRoot(), 1);
    return out;
  }
  function redLabel(el, r) {
    const s = getComputedStyle(el);
    const bits = [`x ${Math.round(r.left + scrollX)}`, `w ${Math.round(r.width)}`];
    if (!allZero(s.padding)) bits.push(`pad ${px(s.padding)}`);
    if (s.gap && s.gap !== 'normal' && !allZero(s.gap)) bits.push(`gap ${px(s.gap)}`);
    return `<b>${esc(label(el))}</b>${bits.map((b) => `<span>${esc(b)}</span>`).join('')}`;
  }
  function drawRedlines() {
    if (!redLayer) return;
    redLayer.textContent = '';
    const placed = [];   // label rects already on screen, so the next one can step out of the way
    for (const { el, depth } of sections()) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const s = getComputedStyle(el);
      const b = document.createElement('div');
      b.className = 'ct-rb ct-d' + depth;
      Object.assign(b.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      const pt = parseFloat(s.paddingTop), pr = parseFloat(s.paddingRight), pb = parseFloat(s.paddingBottom), pl = parseFloat(s.paddingLeft);
      if (pt || pr || pb || pl) {
        const p = document.createElement('i');
        p.className = 'ct-rp';
        Object.assign(p.style, { top: pt + 'px', right: pr + 'px', bottom: pb + 'px', left: pl + 'px' });
        b.appendChild(p);
      }
      const l = document.createElement('div');
      l.className = 'ct-rl'; l.innerHTML = redLabel(el, r);
      redLayer.appendChild(b); redLayer.appendChild(l);
      // Labels go in the margin, not on the page. Most sites leave a column of nothing to the left
      // of the content, and a label there can never cover a word; it sits level with the box's top
      // edge with a tick pointing in. Nested blocks share that edge, so labels stack downwards
      // against the ones already placed. Only when there's no margin does it fall back to sitting
      // just above the box, and inside the top-left corner when there's no room above either.
      const lw = l.offsetWidth, lh = 16;
      let lx, ly = r.top;
      if (r.left >= lw + 14) { lx = r.left - lw - 10; l.classList.add('ct-out'); }
      else { lx = Math.min(Math.max(2, r.left), innerWidth - lw - 2); ly = r.top - 18 >= 2 ? r.top - 18 : r.top + 2; }
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find((q) => lx < q.x + q.w && lx + lw > q.x && ly < q.y + q.h && ly + lh > q.y);
        if (!hit) break;
        ly = hit.y + hit.h + 3;
      }
      placed.push({ x: lx, y: ly, w: lw, h: lh });
      Object.assign(l.style, { left: lx + 'px', top: ly + 'px' });
    }
  }
  function redSchedule() {
    if (redTick) return;
    redTick = requestAnimationFrame(() => { redTick = 0; drawRedlines(); });
  }
  function setRedlines(on) {
    if (on === redlines) return;
    redlines = on;
    if (on) {
      redLayer = document.createElement('div'); redLayer.className = 'ct-red';
      document.documentElement.appendChild(redLayer);
      if (box) box.classList.add('ct-hide');
      addEventListener('scroll', redSchedule, true);
      addEventListener('resize', redSchedule);
      drawRedlines();
    } else {
      redLayer?.remove(); redLayer = null;
      if (redTick) { cancelAnimationFrame(redTick); redTick = 0; }
      if (box) box.classList.remove('ct-hide');
      removeEventListener('scroll', redSchedule, true);
      removeEventListener('resize', redSchedule);
    }
    if (current) paint();
  }

  /* ---------- full height ---------- */
  // captureVisibleTab only ever sees the viewport, so a page taller than the screen has to be
  // walked: scroll, shoot, scroll, shoot, and stitch the slices back together in the background.
  // Position-fixed furniture is hidden after the first slice, otherwise a sticky header prints
  // itself down the whole image like a flip-book.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_SLICES = 40;

  function fullHeightOf(el, r) {
    if (el === document.documentElement || el === document.body) {
      return Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, r.height);
    }
    return Math.max(r.height, el.scrollHeight || 0);
  }

  function stickies() {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (mine(el)) continue;
      const p = getComputedStyle(el).position;
      if (p === 'fixed' || p === 'sticky') out.push([el, el.style.visibility]);
      if (out.length > 300) break;
    }
    return out;
  }

  async function fullShot(el, at) {
    const r0 = el.getBoundingClientRect();
    const h = fullHeightOf(el, r0);
    const doc = { x: r0.left + scrollX, y: r0.top + scrollY, w: r0.width, h };
    if (doc.w < 8 || doc.h < 8) return toast('Too small to capture', true);

    const m = measure(el);
    const keepX = scrollX, keepY = scrollY;
    const keepBehavior = document.documentElement.style.scrollBehavior;
    const hidden = stickies();
    const capId = 'f' + Date.now();
    let n = 0;

    // Smooth scrolling would have us shooting mid-glide.
    document.documentElement.style.scrollBehavior = 'auto';
    box.style.visibility = 'hidden'; tag.style.visibility = 'hidden';

    try {
      for (let y = doc.y; y < doc.y + doc.h && n < MAX_SLICES; y += innerHeight) {
        scrollTo(doc.x, Math.max(0, Math.round(y)));
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        await sleep(n === 0 ? 220 : 160);        // let lazy images and scroll effects settle
        const shot = await new Promise((res) => send({ type: 'slice', capId, sx: scrollX, sy: scrollY }, res));
        if (!shot || shot.error) throw new Error(shot?.error || 'capture refused');
        n++;
        if (n === 1) for (const [node] of hidden) node.style.visibility = 'hidden';
        if (scrollY + innerHeight >= document.documentElement.scrollHeight - 1) break;
      }
      if (!n) throw new Error('nothing was captured');
      const res = await new Promise((r) => send({ type: 'stitchFull', capId, doc, vw: innerWidth, vh: innerHeight }, r));
      if (!res || res.error) throw new Error(res?.error || 'could not stitch the slices');
      m.full = { screens: n, h: Math.round(doc.h) };
      m.rect = { x: doc.x, y: doc.y, w: doc.w, h: doc.h };
      restore();
      stop();
      ask(at, m, res);
    } catch (e) {
      restore(); stop();
      toast(String(e.message || e), true);
    }

    function restore() {
      for (const [node, v] of hidden) node.style.visibility = v;
      scrollTo(keepX, keepY);
      document.documentElement.style.scrollBehavior = keepBehavior;
      if (box) box.style.visibility = '';
      if (tag) tag.style.visibility = '';
    }
  }

  /* ---------- recording ---------- */
  const rectOf = (o) => ('left' in o ? o : { left: o.x, top: o.y, width: o.w, height: o.h, right: o.x + o.w, bottom: o.y + o.h });
  function frameAt(r) {
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  // The tab is captured whole and cropped to this rect as it records, so the clip is the specimen
  // rather than the browser window. Everything this extension draws lives *outside* the rect —
  // rings spread outward, the tag sits above or below — so none of it lands in the video. That is
  // what lets the recording indicator be as loud as it needs to be.
  function beginRecording(el) {
    recEl = el;
    recRect = el.getBoundingClientRect();
    const rect = { x: recRect.left, y: recRect.top, w: recRect.width, h: recRect.height };
    if (rect.w < 8 || rect.h < 8) return toast('Too small to record', true);

    // Duck our own chrome for a frame so the poster frame is clean, then arm. rAF and the timeout
    // race each other (a throttled tab fires no rAF), so the take must only ever be armed once.
    box.style.visibility = 'hidden'; tag.style.visibility = 'hidden';
    let armed = false;
    const m0 = measure(el);
    const go = () => armed || (armed = true) && send({ type: 'record', rect, vw: innerWidth, vh: innerHeight,
      measure: m0, page: { url: location.href, title: document.title } }, (res) => {
      box.style.visibility = ''; tag.style.visibility = '';
      if (!res || res.error) return toast(res?.error || 'Could not record', true);
      enterRecording(recRect, Date.now(), label(el));
    });
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 150);
  }

  // Entering the recording UI, whether this page started the take or inherited it.
  function enterRecording(r, startedAt, name) {
    recRect = rectOf(r);
    recStart = startedAt;
    recName = name || 'the region';
    recording = true;
    if (!picking) start();
    frameAt(recRect);
    document.body.style.cursor = '';        // the page has to feel normal so you can drive it
    box.classList.add('ct-rec');
    setWatch(true);
    clearInterval(recTick);
    recTick = setInterval(drawRec, 100);
    drawRec();
  }

  function drawRec() {
    if (!recording) return;
    const ms = Date.now() - recStart;
    if (ms >= MAX_MS) return endRecording(false, 'Stopped at the 20s limit.');
    const secs = Math.floor(ms / 1000);
    const r = recRect;
    tag.innerHTML =
      `<div class="ct-row">` +
        `<span class="ct-rec-dot"></span>` +
        `<span class="ct-el">recording</span>` +
        `<span class="ct-size">${String(Math.floor(secs / 60))}:${String(secs % 60).padStart(2, '0')}</span>` +
        `<span class="ct-dim">${esc(recName)}</span>` +
      `</div>` +
      `<div class="ct-bar"><i style="width:${Math.min(100, (ms / MAX_MS) * 100).toFixed(1)}%"></i></div>` +
      `<div class="ct-hint"><kbd>⇧click</kbd> or <kbd>⏎</kbd> stop · <kbd>esc</kbd> discard · ` +
        `plain clicks go to the page · stops itself at 20s</div>`;
    const tw = tag.offsetWidth || 280, th = tag.offsetHeight || 52;
    const above = r.top - th - 8;
    tag.style.top = (above > 4 ? above : Math.min(innerHeight - th - 4, r.bottom + 8)) + 'px';
    tag.style.left = Math.max(4, Math.min(innerWidth - tw - 4, r.left)) + 'px';
  }

  function endRecording(discard, why) {
    if (!recording) return;
    recording = false;
    clearInterval(recTick); recTick = null;
    setWatch(false);
    const at = { x: (recRect?.left || 40) + 8, y: (recRect?.top || 40) + 8 };
    // recEl is gone if the page navigated mid-take; the background kept a measurement for exactly this.
    const local = recEl && recEl.isConnected ? measure(recEl) : null;
    box?.classList.remove('ct-rec');
    stop();
    send({ type: 'stopRecord', discard: !!discard }, (res) => {
      if (discard) return toast('Discarded.');
      if (!res || res.error) return toast(res?.error || 'Recording failed', true);
      if (why) toast(why);
      ask(at, local || res.measure || { element: recName, rect: { x: 0, y: 0, w: 0, h: 0 } }, res);
    });
  }

  /* ---------- the sentence ---------- */
  function ask(at, m, frozen) {
    card?.remove();
    card = document.createElement('div'); card.className = 'ct-card';
    const on = !!frozen.clipSeconds;
    card.innerHTML =
      `<div class="ct-head"><span class="ct-el">${esc(m.element)}</span>` +
        `<span>${Math.round(m.rect.w)} × ${Math.round(m.rect.h)}</span></div>` +
      `<input type="text" placeholder="What did you notice?" autocomplete="off" spellcheck="false">` +
      `<div class="ct-foot">` +
        `<span class="ct-mode${on ? ' on' : ''}">${on ? `still + ${frozen.clipSeconds}s of motion`
          : frozen.slices > 1 ? `full height · ${frozen.slices} screens` : 'still only'}</span>` +
        `<span><kbd>⏎</kbd> save · <kbd>esc</kbd> discard</span>` +
      `</div>`;
    // Sit clear of the selection, not on top of it — you should still be able to see the thing
    // you're describing. Below it by preference, above when there's no room, cursor as last resort.
    const w = 344, h = 108, gap = 10, r = m.rect;
    const below = r.y + r.h + gap, above = r.y - h - gap;
    card.style.top = (below + h < innerHeight - 8 ? below : above > 8 ? above
      : Math.max(8, Math.min(innerHeight - h - 8, at.y + 12))) + 'px';
    card.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.x)) + 'px';
    document.documentElement.appendChild(card);
    const input = card.querySelector('input');
    input.focus();
    const close = () => { card?.remove(); card = null; };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { close(); send({ type: 'discard', id: frozen.id }); }
      if (e.key === 'Enter') {
        const note = input.value.trim();
        close();
        send({ type: 'save', id: frozen.id, note, measure: m, page: { url: location.href, title: document.title } }, (res) => {
          if (!res || res.error) toast(res?.error || 'Not saved', true);
          else if (res.parked) toast('Choose a folder in the tab that opened — the cutting is waiting');
          else toast(note ? 'Cut.' : 'Cut, unsaid.');
        });
      }
    });
    card.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  function toast(text, err) {
    const t = document.createElement('div'); t.className = 'ct-toast' + (err ? ' ct-err' : ''); t.textContent = text;
    document.documentElement.appendChild(t); setTimeout(() => t.remove(), err ? 3200 : 1400);
  }
  // A second, page-level marker so recording is unmistakable even if the frame is off-screen.
  function setWatch(on) {
    watchDot?.remove(); watchDot = null;
    if (on) {
      watchDot = document.createElement('div'); watchDot.className = 'ct-watch';
      watchDot.innerHTML = '<i></i>recording this element';
      document.documentElement.appendChild(watchDot);
    }
  }

  // Leave the page exactly as it was found, so a newer instance starts from clean ground.
  function retire() {
    if (retired) return;
    retired = true;
    recording = false; if (recTick) { clearInterval(recTick); recTick = null; }
    picking = true; stop();          // force the removeEventListener path regardless of state
    box?.remove(); tag?.remove(); card?.remove(); watchDot?.remove();
    document.querySelectorAll('.ct-box, .ct-tag, .ct-card, .ct-toast, .ct-watch').forEach((n) => n.remove());
    document.body.style.cursor = '';
  }
  window.__cuttings = { retire };

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (retired) return;
    if (msg.type === 'ping') reply({ ok: true });
    // One key does everything: stop a take, close the picker, or open it.
    if (msg.type === 'pick') { recording ? endRecording(false) : picking ? stop() : start(); reply({ ok: true }); }
    // A page that loads mid-take inherits it: the frame comes back at the captured region, the
    // timer keeps its original start, and ⇧click still closes it. Pushed by the background rather
    // than asked for, so ordinary browsing never wakes the service worker.
    if (msg.type === 'resume') { enterRecording(msg.rect, msg.startedAt, msg.element); reply({ ok: true }); }
    if (msg.type === 'takeReady') {
      // The background finished it for us (the cap, or the stream ending). Just show the card.
      recording = false; clearInterval(recTick); recTick = null; setWatch(false);
      box?.classList.remove('ct-rec'); stop();
      ask({ x: 40, y: 40 }, msg.measure || { element: recName || 'recording', rect: { x: 0, y: 0, w: 0, h: 0 } }, msg);
      reply({ ok: true });
    }
    if (msg.type === 'toast') { toast(msg.text, msg.err); reply({ ok: true }); }
  });
})();
