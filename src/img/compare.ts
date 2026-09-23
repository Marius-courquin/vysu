// Before / after over a shots folder: a triptych page for an agent, a slider page for a human.
//
//   compare <shots-dir> [--against <baseline-dir>] [--out <dir>] [--edge 1568] [--rows 2]
//
// A capture `<label>.png` is paired with `<label>-base.png` when `vysu shots --baseline-url` left one
// beside it, else with `<against>/<label>.png`, else with `<label>.prev.png`, the capture a `vysu
// mshot` under the same label replaced; a capture with no baseline is named and skipped. The third
// column is the marked image `<label>-changed.png` diff wrote, or the « après » again when nothing
// changed. Statuses come from `diff.txt` when it is there, and from the verdicts an mshot kept in
// meta.json.
//
// `compare.png` (`compare-1.png`, `compare-2.png`… past `--rows` pairs) is the one to read: three
// columns « avant » / « après » / « zones », one row per pair, the page fitted inside `--edge` px on
// its long side — a model downsizes past ~1568 px, so a bigger page only costs tokens and never shows
// more.
//
// `compare.html` is the one to open: the same pairs as a before/after slider, plus an onion blend and
// a zones toggle, in plain HTML/CSS/JS with no CDN and no asset. A baseline living outside the folder
// is copied in as `<label>-base.png` first, so the page works from relative paths.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { pyRound } from '../core/py.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { byCodePoint, pyPath, pySplitlines, pyStrip } from './fmt.ts';
import { readRgb, resizeFast, sharpOf, type Raster } from './raster.ts';
import { inkBox, svgText } from './text.ts';
import type { Io } from './tools.ts';

const BG = '#f3f4f6';
const CELL = '#ffffff';
const LINE = '#d1d5db';
const TEXT = '#111111';
const SOFT = '#4b5563';
const COLUMNS = ['avant', 'après', 'zones'] as const;
const SAME = 'zones — identique';
const PAD = 20;
const GAP = 14;
const ROW_CAP = 24;
const CELL_CAP = 20;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const stem = (name: string): string => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);

function captures(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort(byCodePoint)
    .filter((f) => !(f.startsWith('sheet') || f.startsWith('compare') || f.endsWith('-changed.png') || f.endsWith('-base.png') || f.endsWith('.prev.png')));
}

// `<label>: <status>` per unindented diff.txt line (the indented ones are the zone detail), then the
// latest verdict an mshot kept in meta.json, which wins: it is the newer of the two.
export function statuses(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const path = join(dir, 'diff.txt');
  const lines = existsSync(path) ? pySplitlines(readFileSync(path, 'utf8')) : [];
  for (const line of lines) {
    if (!line || /^\s/u.test(line[0]!) || !line.includes(': ')) continue;
    const at = line.indexOf(': ');
    // The pixel count is already in the zone lines: a row caption only needs the headline.
    found.set(line.slice(0, at), pyStrip(line.slice(at + 2)).replace(/ \(\d+ px\)/g, ''));
  }
  let verdicts: Record<string, Record<string, unknown>> = {};
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    verdicts = (meta.verdicts as typeof verdicts) || {};
  } catch {
    verdicts = {};
  }
  for (const [label, v] of Object.entries(verdicts)) {
    if (v && v.vs) found.set(label, `vs ${pyStr(v.vs)} · ${pyStr(v.verdict)}`);
  }
  return found;
}

// "%s" of a JSON value, as Python printed it.
const pyStr = (v: unknown): string => (v === undefined || v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v));

interface Pair {
  label: string;
  base: string;
  current: string;
  marked: string | null;
}

function pairs(shots: string, against: string | null): { found: Pair[]; skipped: string[] } {
  const found: Pair[] = [];
  const skipped: string[] = [];
  for (const f of captures(shots)) {
    const label = stem(f);
    let base = join(shots, `${label}-base.png`);
    if (!existsSync(base)) {
      const other = against ? join(against, `${label}.png`) : null;
      base = other && existsSync(other) ? other : join(shots, `${label}.prev.png`);
      if (!existsSync(base)) {
        skipped.push(label);
        continue;
      }
    }
    const marked = join(shots, `${label}-changed.png`);
    found.push({ label, base, current: join(shots, f), marked: existsSync(marked) ? marked : null });
  }
  return { found, skipped };
}

type Size = [number, number];

const rowHeight = (sizes: Size[], inner: number): number => Math.max(...sizes.map(([w, h]) => pyRound(h * Math.min(1, inner / w))));

// Column width, per-row image height and page height for a page `width` px wide.
function measure(rows: Size[][], width: number): { colW: number; heights: number[]; total: number } {
  const colW = Math.floor((width - 2 * PAD - 2 * GAP) / 3);
  const heights = rows.map((sizes) => rowHeight(sizes, colW - 2));
  const total = 2 * PAD + heights.reduce((s, h) => s + ROW_CAP + h + CELL_CAP + GAP, 0) - GAP;
  return { colW, heights, total };
}

// Text placed by its ink box, as the Python did (no font anchor): left-top, or centred on x.
function inkText(text: string, x: number, y: number, size: number, fill: string, centre = false): string {
  const [x0, y0, x1] = inkBox(text, size);
  const left = centre ? x - (x1 - x0) / 2 : x;
  return svgText(text, left - x0, y - y0, size, fill);
}

// One triptych page: three columns per pair, scaled so the long side stays inside `edge`.
async function compose(page: Array<Array<[string, string]>>, labels: string[], edge: number, out: string): Promise<string> {
  const cache = new Map<string, Promise<Raster>>();
  const load = (p: string): Promise<Raster> => {
    if (!cache.has(p)) cache.set(p, readRgb(p));
    return cache.get(p)!;
  };
  const images = await Promise.all(page.map((cells) => Promise.all(cells.map(([p]) => load(p)))));
  const sizes: Size[][] = images.map((row) => row.map((im) => [im.width, im.height] as Size));
  const widest = Math.max(...sizes.flat().map(([w]) => w));
  let width = Math.min(edge, 2 * PAD + 2 * GAP + 3 * widest);
  for (let i = 0; i < 4; i++) {
    const { total } = measure(sizes, width);
    if (total <= edge) break;
    width = Math.max(3 * 120, pyRound((width * edge) / total));
  }
  const { colW, heights, total } = measure(sizes, width);

  const under: string[] = [];
  const over: string[] = [];
  const layers: OverlayOptions[] = [];
  let y = PAD;
  for (let r = 0; r < page.length; r++) {
    const height = heights[r]!;
    over.push(inkText(labels[r]!, PAD, y, 15, TEXT));
    y += ROW_CAP;
    for (let i = 0; i < 3; i++) {
      const x = PAD + i * (colW + GAP);
      under.push(`<rect x="${x}" y="${y}" width="${colW}" height="${height}" fill="${CELL}"/>`);
      let thumb = images[r]![i]!;
      const scale = Math.min(1, (colW - 2) / thumb.width, (height - 2) / thumb.height);
      if (scale < 1) thumb = await resizeFast(thumb, Math.max(1, pyRound(thumb.width * scale)), Math.max(1, pyRound(thumb.height * scale)));
      layers.push({
        input: await sharpOf(thumb).png({ compressionLevel: 0 }).toBuffer(),
        left: x + Math.floor((colW - thumb.width) / 2),
        top: y + Math.floor((height - thumb.height) / 2),
      });
      over.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${colW - 1}" height="${height - 1}" fill="none" stroke="${LINE}" stroke-width="1"/>`);
      over.push(inkText(page[r]![i]![1], x + Math.floor(colW / 2), y + height + 4, 12, SOFT, true));
    }
    y += height + CELL_CAP + GAP;
  }
  const svg = (parts: string[]): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}">${parts.join('')}</svg>`);
  await sharp({ create: { width, height: total, channels: 3, background: BG } })
    .composite([{ input: svg(under), left: 0, top: 0 }, ...layers, { input: svg(over), left: 0, top: 0 }])
    .png()
    .toFile(out);
  return `${pyPath(out)} ${width}x${total}`;
}

const HTML_HEAD = (title: string, subtitle: string): string => `<!doctype html><meta charset="utf-8"><title>compare — ${title}</title>
<style>
body{margin:0;padding:24px;background:#e5e7eb;font:13px/1.5 system-ui,sans-serif;color:#111}
h1{font-size:15px;margin:0 0 16px}
figure{margin:0 0 24px;background:#f9fafb;border:1px solid #d1d5db;border-radius:8px;padding:12px}
figcaption{margin-bottom:8px;font-variant-numeric:tabular-nums}
.stage{position:relative;overflow:hidden;background:#fff;border:1px solid #d1d5db}
.stage img{display:block;width:100%;height:auto}
.stage .before{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
  clip-path:inset(0 calc(100% - var(--x)) 0 0)}
.stage .zones{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;
  background:#fff;visibility:hidden}
.stage::after{content:"";position:absolute;top:0;bottom:0;left:var(--x);width:2px;background:#e11d48}
.stage.onion .before{clip-path:none;opacity:var(--o)}
.stage.onion::after{display:none}
.stage.zones .before,.stage.zones::after{display:none}
.stage.zones .zones{visibility:visible}
.bar{display:flex;align-items:center;gap:10px;margin-top:8px}
.bar input{flex:1}
button{font:inherit;padding:3px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer}
button[aria-pressed="true"]{background:#111;color:#fff;border-color:#111}
</style>
<h1>${title} — ${subtitle}</h1>
<script>
function slide(el){const s=el.closest('figure').querySelector('.stage');
  s.style.setProperty('--x',el.value+'%');s.style.setProperty('--o',el.value/100)}
function mode(btn,name){const f=btn.closest('figure'),s=f.querySelector('.stage');
  const on=!btn.getAttribute('aria-pressed')||btn.getAttribute('aria-pressed')==='false';
  f.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed','false'));
  s.classList.remove('onion','zones');
  btn.setAttribute('aria-pressed',on);if(on)s.classList.add(name)}
</script>
`;

interface HtmlRow {
  label: string;
  caption: string;
  before: string;
  after: string;
  zones: string;
}

function writeHtml(rows: HtmlRow[], out: string, title: string, subtitle: string): string {
  const parts = [HTML_HEAD(title, subtitle)];
  for (const { label, caption, before, after, zones } of rows) {
    parts.push(`<figure><figcaption>${caption}</figcaption>`);
    parts.push('<div class="stage" style="--x:50%;--o:0.5">');
    parts.push(`<img class="after" src="${after}" alt="${label} après">`);
    parts.push(`<img class="before" src="${before}" alt="${label} avant">`);
    if (zones) parts.push(`<img class="zones" src="${zones}" alt="${label} zones">`);
    parts.push(
      '</div><div class="bar">' +
        '<input type="range" min="0" max="100" value="50" oninput="slide(this)">' +
        '<button aria-pressed="false" onclick="mode(this,\'onion\')">onion</button>',
    );
    if (zones) parts.push('<button aria-pressed="false" onclick="mode(this,\'zones\')">zones</button>');
    parts.push('</div></figure>');
  }
  writeFileSync(out, parts.join('\n'));
  return pyPath(out);
}

export interface CompareOptions {
  against?: string | null;
  out?: string | null;
  edge?: number;
  rows?: number;
}

export class CompareError extends Error {}

// The lines the Python printed, each handed to `emit` as it comes (a « no baseline » line is said
// before the error that follows it). Throws CompareError for what ended it with exit 1.
export async function compare(shots: string, o: CompareOptions, emit: (line: string) => void): Promise<void> {
  const edge = o.edge ?? 1568;
  const perPage = o.rows ?? 2;
  if (!isDir(shots)) throw new CompareError(`compare: no shots folder ${pyPath(shots)}`);
  if (o.against && !isDir(o.against)) throw new CompareError(`compare: no baseline folder ${pyPath(o.against)}`);
  const outDir = o.out || shots;
  mkdirSync(outDir, { recursive: true });

  const { found, skipped } = pairs(shots, o.against ?? null);
  if (skipped.length) emit(`no baseline: ${skipped.join(', ')}`);
  if (!found.length) throw new CompareError(`compare: no pair in ${pyPath(shots)}`);

  const status = statuses(shots);
  let copied = 0;
  const pageRows: Array<{ cells: Array<[string, string]>; caption: string }> = [];
  const htmlRows: HtmlRow[] = [];
  // The pages may sit outside the shots folder: address the images from there.
  const rel = (p: string): string => relative(resolve(outDir), resolve(p)) || '.';
  for (const p of found) {
    let base = p.base;
    if (resolve(join(base, '..')) !== resolve(shots)) {
      // The slider page addresses its images relatively: a baseline from elsewhere moves in.
      const moved = join(shots, `${p.label}-base.png`);
      copyFileSync(base, moved);
      base = moved;
      copied++;
    }
    const caption = status.has(p.label) ? `${p.label} — ${status.get(p.label)}` : p.label;
    pageRows.push({
      cells: [
        [base, COLUMNS[0]],
        [p.current, COLUMNS[1]],
        [p.marked ?? p.current, p.marked ? COLUMNS[2] : SAME],
      ],
      caption,
    });
    htmlRows.push({ label: p.label, caption, before: rel(base), after: rel(p.current), zones: p.marked ? rel(p.marked) : '' });
  }
  if (copied) emit(`copied ${copied} baseline(s) into ${pyPath(shots)}`);

  const pages: (typeof pageRows)[] = [];
  for (let i = 0; i < pageRows.length; i += perPage) pages.push(pageRows.slice(i, i + perPage));
  for (let i = 0; i < pages.length; i++) {
    const name = pages.length === 1 ? 'compare.png' : `compare-${i + 1}.png`;
    const page = pages[i]!;
    emit(await compose(page.map((r) => r.cells), page.map((r) => r.caption), edge, join(outDir, name)));
  }
  const count = `${found.length} paire${found.length > 1 ? 's' : ''}`;
  emit(writeHtml(htmlRows, join(outDir, 'compare.html'), basename(pyPath(shots)), count));
}

const SPEC: ParserSpec = {
  prog: 'compare',
  usage: `usage: compare [-h] [--against AGAINST] [--out OUT] [--edge EDGE]
               [--rows ROWS]
               shots`,
  pos: [{ name: 'shots' }],
  opts: {
    '--against': { kind: 'str' },
    '--out': { kind: 'str' },
    '--edge': { kind: 'int', def: 1568 },
    '--rows': { kind: 'int', def: 2 },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  try {
    await compare(a.shots as string, { against: a.against as string | null, out: a.out as string | null, edge: a.edge as number, rows: a.rows as number }, (l) =>
      io.out(`${l}\n`),
    );
  } catch (e) {
    if (!(e instanceof CompareError)) throw e;
    io.err(`${e.message}\n`);
    return 1;
  }
  return 0;
}
