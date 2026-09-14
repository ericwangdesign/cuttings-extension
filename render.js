// A cutting on disk: one markdown note with its pixels in a folder beside it. This is the whole
// format, rendered here so the extension can write it anywhere — a folder of the user's choosing,
// or the vault reader, which renders the same note from the same payload. Pure: no chrome.*, no
// filesystem, so it runs in the service worker and in node alike.

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const site = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'page'; } };
const folderName = (s) => String(s || '').replace(/[\n\r"]/g, '').trim().slice(0, 60);
const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
// A long-page capture comes back as JPEG, an element as PNG — keep the real extension either way.
const ext = (d) => (/^data:image\/jpe?g/.test(d) ? 'jpg' : /^data:video/.test(d) ? 'webm' : 'png');

// c: { note, folder, page: { url, title }, measure, still, viewport, clip, seconds } — data URLs for the
// pixels. Returns the files to write, paths relative to the cuttings folder: the note as text,
// the pixels still as data URLs for whoever writes them to turn into bytes.
export function renderCutting(c, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const stamp = day + '-' + now.toTimeString().slice(0, 8).replace(/:/g, '');
  const host = site(c.page?.url);
  const name = `${stamp}-${slug(host)}`;

  const m = c.measure || {};
  const files = [], assets = {};
  if (c.still) { const f = 'still.' + ext(c.still); files.push({ path: `${name}/${f}`, dataUrl: c.still }); assets.still = `${name}/${f}`; }
  if (c.viewport) { const f = 'viewport.' + ext(c.viewport); files.push({ path: `${name}/${f}`, dataUrl: c.viewport }); assets.viewport = `${name}/${f}`; }
  if (c.clip) { files.push({ path: `${name}/clip.webm`, dataUrl: c.clip }); assets.clip = `${name}/clip.webm`; }
  const seconds = c.clip ? Math.max(1, Math.round(c.seconds || 0)) : 0;

  const note = (c.note || '').trim();
  const title = note || `${m.element || 'a piece'} on ${host}`;
  const styleLines = Object.entries(m.styles || {}).map(([k, v]) => `- ${k}: \`${v}\``);
  const motionLines = (m.motion || []).flatMap((x) => [
    x.transition ? `- ${x.on} — transition \`${x.transition}\`` : null,
    x.animation ? `- ${x.on} — animation \`${x.animation}\`` : null,
  ].filter(Boolean));

  const body = [
    note ? null : '_Nothing said — the image is the note._\n',
    '## Source',
    `[${(c.page?.title || host).replace(/[\[\]]/g, '')}](${c.page?.url || ''})`,
    m.text ? `> ${m.text}` : null,
    '',
    '## Measured',
    `- element: \`${m.element || '?'}\` · ${Math.round(m.rect?.w || 0)}×${Math.round(m.rect?.h || 0)} in a ${m.viewport?.w}×${m.viewport?.h} viewport`,
    seconds ? `- clip: ${seconds}s, cropped to the element` : null,
    m.full ? `- full height: ${m.full.h}px, stitched from ${m.full.screens} screens` : null,
    m.surface?.kind === 'canvas' ? `- canvas ${m.surface.w}×${m.surface.h} — the type, colour and motion are in the shader, not the CSS. The clip is the only record.` : null,
    m.fonts?.length ? `- type: ${m.fonts.join('; ')}` : null,
    m.palette?.length ? `- palette: ${m.palette.map((p) => `\`${p}\``).join(' ')}` : null,
    ...(motionLines.length ? ['', '### Motion', ...motionLines] : m.surface?.kind === 'canvas' ? [] : ['- motion: none declared in CSS']),
    ...(styleLines.length ? ['', '### Computed', ...styleLines] : []),
    '',
  ]
    .filter((l) => l !== null && l !== undefined)
    // Absent fields leave empty strings behind; collapse runs of them so the note never
    // opens on a blank or shows a gap where a measurement simply wasn't there.
    .reduce((out, l) => (l.trim() === '' && (!out.length || out[out.length - 1] === '') ? out : [...out, l]), [])
    .join('\n')
    .trimEnd() + '\n';

  const fm = [
    '---',
    `name: ${name}`,
    `title: ${q(title)}`,
    `description: ${q(note ? `${host} — ${note}` : `${m.element || 'a piece'} on ${host}`)}`,
    'metadata:',
    '  type: cutting',
    `source: ${q(c.page?.url || '')}`,
    `site: ${host}`,
    folderName(c.folder) ? `folder: ${q(folderName(c.folder))}` : null,
    assets.still ? `still: ${assets.still}` : null,
    assets.viewport ? `viewport: ${assets.viewport}` : null,
    assets.clip ? `clip: ${assets.clip}` : null,
    seconds ? `seconds: ${seconds}` : null,
    m.full?.screens ? `screens: ${m.full.screens}` : null,
    `created: ${day}`,
    `updated: ${day}`,
    `tags: [cutting, ${slug(host)}]`,
    '---',
    '',
  ].filter(Boolean).join('\n');

  files.unshift({ path: `${name}.md`, text: fm + '\n' + body });
  return { name, title, files };
}
