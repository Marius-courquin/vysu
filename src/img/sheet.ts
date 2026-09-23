// Contact sheets of a shots folder: the PNG an agent reads back, and index.html for a human.
//
// A model downsizes an image past a 1568 px long edge (then ≈ w×h/750 tokens), so a page bigger than
// that square only costs tokens and shows less: every page is composed to fit inside `edge`, and a
// thumbnail is never blown up past its own pixels. A grid page picks its column count for the largest
// thumbnails that fit (six phone captures: three columns, two rows, one page); past `max` captures
// the folder is split into pages of even size. `sheet.png` (`sheet-1.png`, `sheet-2.png`…) plus
// `index.html`, which holds the same captures at full size.
//
// `strip` is one row instead, every capture at the same scale so a before and an after line up:
// `sheet-strip.png`. It leaves the grid pages and index.html alone.
//
// Picked by default: every capture, in the order they were taken, a `-base.png` next to its current.
// Left out: sheets, compare pages, a marked diff (`-changed.png`) and the capture an mshot replaced
// (`.prev.png`): they are read on their own. `only` picks captures by file name instead, in the order
// of its globs (then by time within one glob); a glob reaches a `.prev.png` or a `-changed.png` only
// when it spells it (`*.prev.png`, `*-changed.png`), so `android-home*` stays the captures.
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { die } from '../core/errors.ts';
import { fnmatch, htmlEscape, pyRound } from '../core/py.ts';
import { stamp } from '../core/text.ts';
import { ellipsize, svgText } from './text.ts';

const BG = '#f3f4f6';
const CELL = '#ffffff';
const LINE = '#d1d5db';
const TEXT = '#111111';
const SOFT = '#4b5563';
const PAD = 16; // page margin
const GAP = 12; // gutter
const HEAD = 30; // title line
const CAP = 20; // caption line under a thumbnail

type Size = [number, number];

function sideFile(name: string): 'prev' | 'changed' | null {
  if (name.endsWith('.prev.png')) return 'prev';
  if (name.endsWith('-changed.png')) return 'changed';
  return null;
}

// A leading dot is a capture in flight (mshot writes `.<label>.new.png` before it renames it).
function candidates(dir: string): string[] {
  return readdirSync(dir).filter((f) => {
    if (!f.endsWith('.png') || f.startsWith('.') || f.startsWith('sheet') || f.startsWith('compare')) return false;
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
}

export function pick(dir: string, only: string[]): string[] {
  const files = candidates(dir);
  const t = (f: string): number => statSync(join(dir, f)).mtimeMs;
  const byTime = (a: string, b: string): number => t(a) - t(b);
  if (only.length) {
    const order: string[] = [];
    for (const glob of only) {
      const hits = files.filter((f) => {
        const side = sideFile(f);
        return fnmatch(f, glob) && (side === null || glob.includes(side)) && !order.includes(f);
      });
      order.push(...hits.sort(byTime));
    }
    return order;
  }
  const plain = files.filter((f) => sideFile(f) === null).sort(byTime);
  // A baseline sits right before its current, whatever the order they were written in.
  const bases = new Map<string, string>();
  for (const f of plain) if (f.endsWith('-base.png')) bases.set(`${f.slice(0, -'-base.png'.length)}.png`, f);
  const order: string[] = [];
  for (const f of plain) {
    if (f.endsWith('-base.png')) continue;
    const b = bases.get(f);
    if (b) order.push(b);
    order.push(f);
  }
  return [...order, ...plain.filter((f) => f.endsWith('-base.png') && !order.includes(f))];
}

// Cell size, rows and the thumbnail scales of `sizes` laid out on `cols` columns.
function grid(sizes: Size[], cols: number, edge: number): { rows: number; scales: number[] } | null {
  const rows = Math.ceil(sizes.length / cols);
  const cellW = (edge - 2 * PAD - (cols - 1) * GAP) / cols;
  const cellH = (edge - 2 * PAD - HEAD - (rows - 1) * GAP) / rows - CAP;
  if (cellW < 40 || cellH < 40) return null;
  return { rows, scales: sizes.map(([w, h]) => Math.min(1, (cellW - 2) / w, (cellH - 2) / h)) }; // 2: the border
}

// The column count (given, or the one with the largest thumbnails), then the scale of each.
export function layout(sizes: Size[], cols: number, edge: number): { cols: number; scales: number[] } {
  const tried = cols ? [cols] : Array.from({ length: sizes.length }, (_, i) => i + 1);
  let best: { key: [number, number]; cols: number; scales: number[] } | undefined;
  for (const c of tried) {
    const g = grid(sizes, c, edge);
    if (!g) continue;
    const width = Math.max(...sizes.map(([w], i) => pyRound(w * g.scales[i]!)));
    const height = Math.max(...sizes.map(([, h], i) => pyRound(h * g.scales[i]!)));
    const area = c * width * (g.rows * height);
    // Largest worst thumbnail first; between equals, the smaller page (fewer tokens, same picture).
    const key: [number, number] = [pyRound(Math.min(...g.scales), 3), -area];
    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { key, cols: c, scales: g.scales };
  }
  if (!best) die(`--cols ${cols} leaves no room for a thumbnail`);
  return { cols: best.cols, scales: best.scales };
}

async function compose(dir: string, names: string[], scales: number[], cols: number, title: string, edge: number, out: string): Promise<void> {
  const thumbs = await Promise.all(
    names.map(async (name, i) => {
      const img = sharp(join(dir, name)).removeAlpha();
      const meta = await sharp(join(dir, name)).metadata();
      const s = scales[i]!;
      let w = meta.width ?? 1;
      let h = meta.height ?? 1;
      let pipe = img;
      if (s < 1) {
        w = Math.max(1, pyRound(w * s));
        h = Math.max(1, pyRound(h * s));
        pipe = img.resize(w, h, { kernel: 'lanczos3', fit: 'fill' });
      }
      return { input: await pipe.png({ compressionLevel: 0 }).toBuffer(), w, h };
    }),
  );
  const rows = Math.ceil(thumbs.length / cols);
  // Cells as wide as the widest thumbnail of the page: a page of small captures stays small. Wide
  // enough for a caption all the same, as long as the columns still fit the square.
  const cellW = Math.max(Math.max(...thumbs.map((t) => t.w)) + 2, Math.min(180, Math.floor((edge - 2 * PAD - (cols - 1) * GAP) / cols)));
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(...thumbs.slice(r * cols, (r + 1) * cols).map((t) => t.h)) + 2);
  const width = 2 * PAD + cols * cellW + (cols - 1) * GAP;
  const height = 2 * PAD + HEAD + rowH.reduce((a, h) => a + h + CAP, 0) + (rows - 1) * GAP;

  const svg: string[] = [svgText(ellipsize(title, 15, width - 2 * PAD), PAD, PAD, 15, TEXT)];
  const layers: OverlayOptions[] = [];
  let y = PAD + HEAD;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols && r * cols + c < thumbs.length; c++) {
      const i = r * cols + c;
      const t = thumbs[i]!;
      const x = PAD + c * (cellW + GAP);
      svg.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${cellW - 1}" height="${rowH[r]! - 1}" fill="${CELL}" stroke="${LINE}" stroke-width="1"/>`);
      layers.push({ input: t.input, left: x + Math.floor((cellW - t.w) / 2), top: y + 1 });
      svg.push(svgText(ellipsize(names[i]!.slice(0, -4), 12, cellW - 4), x + 2, y + rowH[r]! + 4, 12, SOFT));
    }
    y += rowH[r]! + CAP + GAP;
  }
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.join('')}</svg>`,
  );
  await sharp({ create: { width, height, channels: 3, background: BG } })
    .composite([{ input: overlay, left: 0, top: 0 }, ...layers])
    .png()
    .toFile(out);
}

function writeHtml(dir: string, title: string, pages: string[][], edge: number): string {
  const out = [
    `<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>body{margin:0;background:#e5e7eb;font:12px/1.4 system-ui,sans-serif;color:#111}
section{max-width:${edge}px;box-sizing:border-box;padding:16px;background:#f3f4f6;display:grid;gap:12px;
grid-template-columns:repeat(auto-fill,minmax(240px,1fr));align-items:start}
h1{grid-column:1/-1;font-size:14px;margin:0}
figure{margin:0;background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:6px;min-width:0}
img{display:block;max-width:100%;height:auto;margin:0 auto}
figcaption{margin-top:4px;color:#4b5563;font-variant-numeric:tabular-nums}</style>`,
  ];
  pages.forEach((page, i) => {
    const suffix = pages.length > 1 ? ` · ${i + 1}/${pages.length}` : '';
    out.push(`<section id="p${i + 1}"><h1>${htmlEscape(title)}${suffix}</h1>`);
    for (const f of page) out.push(`<figure><img src="${htmlEscape(f)}" alt="${htmlEscape(f)}"><figcaption>${htmlEscape(f)}</figcaption></figure>`);
    out.push('</section>');
  });
  const path = join(dir, 'index.html');
  writeFileSync(path, out.join('\n'));
  return path;
}

export interface SheetOptions {
  name?: string;
  cols?: number;
  max?: number;
  edge?: number;
  only?: string;
  strip?: boolean;
}

// The files written, in the order they have always been printed: index.html first for a grid.
export async function sheet(dir: string, o: SheetOptions): Promise<string[]> {
  const edge = o.edge ?? 1568;
  const onlyRaw = o.only ?? '';
  const only = onlyRaw
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  const names = pick(dir, only);
  if (!names.length) die(`no capture ${only.length ? `matches « ${onlyRaw} » ` : ''}in ${dir}`);
  const title = `${o.name || dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop()} · ${stamp()}`;
  const sizes: Size[] = await Promise.all(
    names.map(async (f) => {
      const m = await sharp(join(dir, f)).metadata();
      return [m.width ?? 1, m.height ?? 1] as Size;
    }),
  );

  if (o.strip) {
    // One scale for all: a before and an after of one screen stay the same size, and a smaller phone
    // still reads smaller. The row is fitted inside the square like any page.
    const roomW = (edge - 2 * PAD - (names.length - 1) * GAP) / names.length - 2;
    const roomH = edge - 2 * PAD - HEAD - CAP - 2;
    const scale = Math.min(1, roomW / Math.max(...sizes.map(([w]) => w)), roomH / Math.max(...sizes.map(([, h]) => h)));
    const out = join(dir, 'sheet-strip.png');
    await compose(dir, names, names.map(() => scale), names.length, title, edge, out);
    return [out];
  }

  for (const stale of readdirSync(dir)) {
    if (stale === 'sheet.png' || (stale.startsWith('sheet-') && stale.endsWith('.png') && /^\d+$/.test(stale.slice(6, -4)))) {
      rmSync(join(dir, stale), { force: true });
    }
  }
  const count = Math.ceil(names.length / Math.max(1, o.max ?? 6));
  const per = Math.ceil(names.length / count); // 8 captures are two pages of 4, not a page of 6 and one of 2
  const pages: string[][] = [];
  for (let i = 0; i < names.length; i += per) pages.push(names.slice(i, i + per));
  const written = [writeHtml(dir, title, pages, edge)];
  const outs = await Promise.all(
    pages.map(async (page, i) => {
      const l = layout(
        page.map((f) => sizes[names.indexOf(f)]!),
        o.cols ?? 0,
        edge,
      );
      const out = join(dir, pages.length === 1 ? 'sheet.png' : `sheet-${i + 1}.png`);
      await compose(dir, page, l.scales, l.cols, pages.length > 1 ? `${title} · ${i + 1}/${pages.length}` : title, edge, out);
      return out;
    }),
  );
  return [...written, ...outs];
}
