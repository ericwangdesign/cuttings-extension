#!/usr/bin/env node
// Reads a folder of cuttings as one set and writes a style guide of what they have in common.
// Runs through the `claude` CLI, so it uses whatever Claude account is signed in on this machine —
// no API key to keep.
//
//   node analyze.mjs <cuttings-dir> <folder>          cuttings you filed under that folder
//   node analyze.mjs <any-dir-of-photos>              every image in a plain directory
//   --focus "the typography"                          what to look at (default: the building)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const fi = args.indexOf('--focus');
const focus = fi >= 0 ? args.splice(fi, 2)[1] : 'the building';
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

const prompt = [
  `These ${shots.length} photos are one folder of visual references called "${name}". Read every one with the Read tool, in order, before writing anything.`,
  '',
  ...shots.map((s, i) => `${i + 1}. ${s.path}${s.note ? ` — my note: "${s.note}"` : ''}`),
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

console.log(`Reading ${shots.length} pictures of "${name}" for ${focus}… (a few minutes)`);
const t0 = Date.now();
const tick = setInterval(() => process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s`), 1000);
const child = spawn('claude', ['-p', '--allowedTools', 'Read', '--add-dir', dir, '--output-format', 'text'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));
child.stdin.end(prompt);
child.on('error', (e) => {
  clearInterval(tick);
  console.error(`\ncouldn't run claude (${e.message}). Install Claude Code and sign in: https://claude.com/claude-code`);
  process.exit(1);
});
child.on('close', (code) => {
  clearInterval(tick);
  const md = out.trim();
  if (code !== 0 || !md) {
    console.error(`\nclaude failed: ${(err || out || `exit ${code}`).trim().slice(-400)}`);
    if (/auth|log ?in|OAuth/i.test(err + out)) console.error('Sign in first: claude auth login');
    process.exit(1);
  }
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
});
