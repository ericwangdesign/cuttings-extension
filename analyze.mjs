#!/usr/bin/env node
// Reads a folder of cuttings as one set and writes a style guide of what they have in common.
//
// Any one of these does the looking, first found wins (or force one with --with):
//   GEMINI_API_KEY      Google AI Studio key — free tier works        --with gemini
//   ANTHROPIC_API_KEY   Claude API key                                --with anthropic
//   OPENAI_API_KEY      OpenAI key                                    --with openai
//   the `claude` CLI    Claude Code, signed in — no key needed        --with claude
// Model can be overridden with GEMINI_MODEL / ANTHROPIC_MODEL / OPENAI_MODEL.
//
//   node analyze.mjs <cuttings-dir> <folder>          cuttings you filed under that folder
//   node analyze.mjs <any-dir-of-photos>              every image in a plain directory
//   --focus "the typography"                          what to look at (default: the building)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const fi = args.indexOf('--focus');
const focus = fi >= 0 ? args.splice(fi, 2)[1] : 'the building';
const wi = args.indexOf('--with');
const forced = wi >= 0 ? args.splice(wi, 2)[1] : null;
const [dirArg, folder] = args;
if (!dirArg) {
  console.log('usage: node analyze.mjs <cuttings-dir> [folder] [--focus "the building"]');
  process.exit(1);
}
const dir = resolve(dirArg.replace(/^~/, process.env.HOME));
if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`not a directory: ${dir}`); process.exit(1); }

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// Minimal frontmatter read: the keys a cutting writes are flat.
function front(file) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  const out = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const m = /^\s*(\w+):\s*(.*)$/.exec(line); // `type` sits nested under metadata:
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
  }
  return out;
}

let shots;
if (folder) {
  shots = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => front(join(dir, f)))
    .filter((d) => d.type === 'cutting' && d.folder === folder && d.still)
    .map((d) => ({ path: join(dir, d.still), note: d.title }));
  if (!shots.length) {
    const known = [...new Set(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => front(join(dir, f)).folder).filter(Boolean))];
    console.error(`nothing with a picture in folder "${folder}".${known.length ? ` Folders here: ${known.join(', ')}` : ''}`);
    process.exit(1);
  }
} else {
  shots = readdirSync(dir).filter((f) => IMG.has(extname(f).toLowerCase())).sort().map((f) => ({ path: join(dir, f) }));
  if (!shots.length) { console.error(`no images in ${dir}. To read filed cuttings, pass the folder name too.`); process.exit(1); }
}
if (shots.length > 40) { console.log(`${shots.length} pictures — reading the first 40.`); shots = shots.slice(0, 40); }
const name = folder || basename(dir);

const hasClaude = () => spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
const env = process.env;
const provider = forced
  || (env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? 'gemini' : env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : hasClaude() ? 'claude' : null);
if (!provider) {
  console.error([
    'Nothing to analyze with. Set one of these, then run again:',
    '  export GEMINI_API_KEY=...      free at https://aistudio.google.com/apikey',
    '  export ANTHROPIC_API_KEY=...   https://console.anthropic.com',
    '  export OPENAI_API_KEY=...      https://platform.openai.com/api-keys',
    'or install Claude Code and run `claude auth login`.',
  ].join('\n'));
  process.exit(1);
}
const viaCli = provider === 'claude';

// APIs take the pictures inline, and each has a ceiling. Drop what won't fit rather than fail the run.
if (!viaCli) {
  const perImage = provider === 'anthropic' ? 5e6 : 15e6;
  const total = provider === 'gemini' ? 18e6 : Infinity;
  let used = 0;
  shots = shots.filter((s) => {
    const size = statSync(s.path).size;
    const ok = size <= perImage && used + size <= total;
    if (ok) used += size; else console.log(`skipping ${basename(s.path)} — too big to send (${(size / 1e6).toFixed(1)}MB)`);
    return ok;
  });
  if (!shots.length) { console.error('every picture was too big to send.'); process.exit(1); }
}
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const b64 = (p) => readFileSync(p).toString('base64');
const mime = (p) => MIME[extname(p).toLowerCase()] || 'image/png';

const prompt = [
  `These ${shots.length} photos are one folder of visual references called "${name}". ${viaCli ? 'Read every one with the Read tool, in order, before writing anything.' : 'They are attached in order, each labelled with its number.'}`,
  '',
  ...shots.map((s, i) => `${i + 1}. ${viaCli ? s.path : basename(s.path)}${s.note ? ` — my note: "${s.note}"` : ''}`),
  '',
  `Analyze only ${focus} in each photo. Ignore the sky, people, cars, cropping, captions, website UI and photographic style unless it changes how ${focus} reads.`,
  '',
  'Then write a style guide: the commonalities across the set, so someone could design a new one that belongs in this folder. Rules:',
  '- Lead with what nearly all of them share. Say how many photos show each trait, like (9/12), and cite photo numbers.',
  '- Be concrete and measurable where you can: proportions and ratios, storey counts, window-to-wall, roof pitch, rhythm of bays, material names, colours as approximate hex.',
  '- Sections, in this order: "## The short version" (5 bullets max), "## Massing and proportion", "## Facade and openings", "## Materials and colour", "## Roof and edges", "## Details", "## Ground and setting", "## Where they disagree" (the real splits, and the outliers by number), "## To design one" (a checklist of do / don\'t).',
  '- Skip a section if the photos genuinely say nothing about it. No preamble, no sign-off, no title heading. Plain, casual English, short sentences.',
  '- Output only the markdown of the guide.',
].join('\n');

console.log(`Reading ${shots.length} pictures of "${name}" for ${focus} with ${provider}… (a minute or two)`);
const t0 = Date.now();
const tick = setInterval(() => process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s`), 1000);

function viaClaudeCli() {
  return new Promise((ok, fail) => {
    const child = spawn('claude', ['-p', '--allowedTools', 'Read', '--add-dir', dir, '--output-format', 'text'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.end(prompt);
    child.on('error', (e) => fail(new Error(`couldn't run claude (${e.message})`)));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) return ok(out);
      const msg = (err || out || `exit ${code}`).trim().slice(-400);
      fail(new Error(/auth|log ?in|OAuth/i.test(msg) ? `${msg}\nSign in first: claude auth login` : msg));
    });
  });
}

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const labelled = (make) => shots.flatMap((s, i) => [make.text(`Photo ${i + 1}`), make.image(s.path)]);

const run = {
  claude: viaClaudeCli,
  gemini: async () => {
    const model = env.GEMINI_MODEL || 'gemini-flash-latest';
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': env.GEMINI_API_KEY || env.GOOGLE_API_KEY },
      { contents: [{ role: 'user', parts: [...labelled({ text: (t) => ({ text: t }), image: (p) => ({ inline_data: { mime_type: mime(p), data: b64(p) } }) }), { text: prompt }] }] });
    return (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
  },
  anthropic: async () => {
    const j = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: env.ANTHROPIC_MODEL || 'claude-opus-5', max_tokens: 8000,
        messages: [{ role: 'user', content: [...labelled({ text: (t) => ({ type: 'text', text: t }), image: (p) => ({ type: 'image', source: { type: 'base64', media_type: mime(p), data: b64(p) } }) }), { type: 'text', text: prompt }] }] });
    return (j.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  },
  openai: async () => {
    const j = await post('https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      { model: env.OPENAI_MODEL || 'gpt-5',
        messages: [{ role: 'user', content: [...labelled({ text: (t) => ({ type: 'text', text: t }), image: (p) => ({ type: 'image_url', image_url: { url: `data:${mime(p)};base64,${b64(p)}` } }) }), { type: 'text', text: prompt }] }] });
    return j.choices?.[0]?.message?.content || '';
  },
}[provider];
if (!run) { clearInterval(tick); console.error(`unknown --with ${provider}. Use gemini, anthropic, openai or claude.`); process.exit(1); }

run().then((text) => {
  clearInterval(tick);
  const md = String(text || '').trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, '$1');
  if (!md) { console.error(`\n${provider} returned nothing.`); process.exit(1); }
  const day = new Date().toISOString().slice(0, 10);
  const guides = join(dir, 'guides');
  mkdirSync(guides, { recursive: true });
  const file = join(guides, `style-guide-${slug(name)}.md`);
  const rel = (p) => p.startsWith(dir + '/') ? '../' + p.slice(dir.length + 1) : p;
  writeFileSync(file, [
    '---',
    `title: "${name}, the style guide"`,
    'type: style-guide',
    `folder: "${name}"`,
    `focus: "${focus}"`,
    `created: ${day}`,
    '---',
    '',
    md,
    '',
    '## The photos',
    ...shots.map((s, i) => `${i + 1}. ![${i + 1}](${encodeURI(rel(s.path))})`),
    '',
  ].join('\n'));
  console.log(`\rDone in ${Math.round((Date.now() - t0) / 1000)}s → ${file}`);
}).catch((e) => {
  clearInterval(tick);
  console.error(`\n${provider} failed: ${e.message}`);
  process.exit(1);
});
