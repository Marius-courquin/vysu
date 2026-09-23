// What a mobile screen says, read from agent-device's `snapshot -i --json`.
//
//   screen line <snap.json> [--prev <keys>] [--save <keys>] [--keyboard auto|yes|no] [--scale <n>]
//   screen has <snap.json> <text> [--visible]
//   screen sig <snap.json> [--geometry]
//   screen field <snap.json> <label>
//   screen editable <snap.json>
//
// `line` is the one line an agent reads after each step: up to six labels in reading order, then the
// node count, what changed since the previous snapshot (its keys saved by --save, read by --prev),
// the keyboard and the focused field when the platform says so (`--scale`: the pixels per point of an
// Android snapshot, whose boxes are in pixels where iOS gives points). `has` answers « is that text
// on screen » the way `agent-device wait text` does (case-insensitive, contained in a label or a
// value), `--visible` asking for its centre inside the viewport and nothing drawn over it (what
// `scroll-to` waits for). `sig` prints the labels on screen as one string: two equal in a row is a
// screen at rest (`--geometry` adds where each one sits: what tells a scroll that moved from one that
// did not). `field` prints the centre of the text field a label names (its own label, else the field
// nearest below a text holding it, else the one unlabelled field on screen, followed by « only »).
// `editable` answers whether any text field is on screen at all.
//
// Exit: 0 yes / printed, 1 no, 2 unreadable snapshot.
import { readFileSync, writeFileSync } from 'node:fs';
import { pyRound } from '../core/py.ts';
import { byCodePoint, casefold, pyFloat, pyRstrip, pySplit, stripChars } from './fmt.ts';
import type { Io } from './tools.ts';

const MAX_LABELS = 6;
const MAX_LABEL_CHARS = 40;
const ICON_EDGE = 56; // pt / dp: a control this small is an icon, and its label is nothing anyone reads

const DOC = `What a mobile screen says, read from agent-device's \`snapshot -i --json\`.

Usage: screen line <snap.json> [--prev <keys>] [--save <keys>] [--keyboard auto|yes|no] [--scale <n>]
       screen has <snap.json> <text> [--visible]
       screen sig <snap.json> [--geometry]
       screen field <snap.json> <label>
       screen editable <snap.json>

\`line\` is the one line an agent reads after each step: up to six labels in reading order, then the
node count, what changed since the previous snapshot (its keys saved by --save, read by --prev), the
keyboard and the focused field when the platform says so (\`--scale\`: the pixels per point of an
Android snapshot, whose boxes are in pixels where iOS gives points). \`has\` answers « is that text on screen »
the way \`agent-device wait text\` does (case-insensitive, contained in a label or a value), \`--visible\`
asking for its centre inside the viewport and nothing drawn over it (what \`scroll-to\` waits for).
\`sig\` prints the labels on screen as one string: two equal in a row is a screen at rest
(\`--geometry\` adds where each one sits: what tells a scroll that moved from one that did not).
\`field\` prints the centre of the text field a label names (its own label, else the field nearest
below a text holding it, else the one unlabelled field on screen, followed by « only »).
\`editable\` answers whether any text field is on screen at all.

Exit: 0 yes / printed, 1 no, 2 unreadable snapshot.
`;

type Node = Record<string, unknown>;
type Rect = [number, number, number, number];
type Viewport = Rect | null;

export interface Snapshot {
  data: Record<string, unknown>;
  // null: nothing readable (no file, not JSON, an error answer without nodes).
  nodes: Node[] | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSnapshot(text: string): Snapshot {
  let data: Record<string, unknown> = {};
  try {
    const top = JSON.parse(text) as unknown;
    const d = isObject(top) ? top.data : undefined;
    data = isObject(d) ? d : {};
  } catch {
    data = {};
  }
  const nodes = Array.isArray(data.nodes) ? (data.nodes as unknown[]).map((n) => (isObject(n) ? n : {})) : null;
  return { data, nodes };
}

export function readSnapshot(path: string): Snapshot {
  try {
    return parseSnapshot(readFileSync(path, 'utf8'));
  } catch {
    return { data: {}, nodes: null };
  }
}

// str(v or ""), for the values a snapshot holds.
function pyStr(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v === true) return 'True';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

// A node's box, or null when it has none that reads as numbers.
function rect(node: Node): Rect | null {
  const r = node.rect;
  if (!isObject(r)) return null;
  const vals = [r.x, r.y, r.width, r.height].map((v) => (v === undefined || v === null ? null : pyFloat(v)));
  return vals.some((v) => v === null) ? null : (vals as Rect);
}

const typeOf = (node: Node): string => pyStr(node.type);

function kind(node: Node): string {
  const t = typeOf(node).toLowerCase().split('.').pop()!;
  if (t === 'key' || t === 'keyboard' || t.includes('keyboard')) return 'keyboard';
  if (['textfield', 'edittext', 'searchfield', 'securetext', 'textinput'].some((k) => t.includes(k)) || node.editable) return 'field';
  if (['statictext', 'textview', 'text', 'heading', 'label'].includes(t)) return 'text';
  if (t.includes('image') && !t.includes('button')) return 'image';
  return 'other';
}

// depth == 0, a missing depth counting as 0.
const isDepth0 = (node: Node): boolean => (node.depth === undefined ? true : node.depth === 0 || node.depth === false);

// The roots are the windows: everything outside them is laid out but not on screen. iOS has one (the
// app, full screen); Android has one per window, and a system dialog's buttons are roots of their own.
function viewport(nodes: Node[]): Viewport {
  let boxes = nodes.filter(isDepth0).map(rect).filter((r): r is Rect => r !== null);
  if (!boxes.length) boxes = nodes.map(rect).filter((r): r is Rect => r !== null);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  return [x0, y0, Math.max(...boxes.map((b) => b[0] + b[2])) - x0, Math.max(...boxes.map((b) => b[1] + b[3])) - y0];
}

// iOS puts the app itself at the top of the tree: it is not something on screen.
const isRoot = (node: Node): boolean => isDepth0(node) && typeOf(node) === 'Application';

// Android says it outright; iOS is judged by the box alone.
function onScreen(node: Node, vp: Viewport, centre = false): boolean {
  if (node.visibleToUser === false) return false;
  const r = rect(node);
  if (!r || !vp) return true;
  const [x, y, w, h] = r;
  if (centre) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    return vp[0] <= cx && cx <= vp[0] + vp[2] && vp[1] <= cy && cy <= vp[1] + vp[3];
  }
  return x < vp[0] + vp[2] && x + w > vp[0] && y < vp[1] + vp[3] && y + h > vp[1];
}

const clean = (text: unknown): string => stripChars(pySplit(pyStr(text)).join(' '), ' ,');

// iOS names its scroll indicators in the system's language (« Barre de défilement verticale,
// 2 pages », « Vertical scroll bar, 1 page ») and gives them a percentage for a value: chrome.
const PAGES = /,\s*\p{Nd}+\s+pages?$/iu;
const scrollIndicator = (node: Node): boolean => PAGES.test(clean(node.label)) || clean(node.value).endsWith('%');

// The keyboard and everything drawn with it (its keys, the prediction bar, the « next keyboard » and
// dictation buttons): iOS hosts all of it in a window of its own, which is left out whole. Without a
// window to go by, only the keyboard's own subtree is.
function keyboardNodes(nodes: Node[]): Set<Node> {
  const byIndex = new Map<unknown, Node>();
  for (const n of nodes) if (n.index !== undefined && n.index !== null) byIndex.set(n.index, n);
  const tops = new Set<Node>();
  for (const n of nodes) {
    if (kind(n) !== 'keyboard') continue;
    let cur = n;
    for (let seen = 0; seen < 64; seen++) {
      const parent = byIndex.get(cur.parentIndex);
      if (!parent || isDepth0(parent)) break;
      cur = parent;
    }
    tops.add(typeOf(cur).toLowerCase() === 'window' ? cur : n);
  }
  const out = new Set<Node>();
  if (!tops.size) return out;
  for (const n of nodes) {
    let cur: Node | undefined = n;
    for (let seen = 0; cur && seen < 64; seen++) {
      if (tops.has(cur)) {
        out.add(n);
        break;
      }
      cur = byIndex.get(cur.parentIndex);
    }
    if (kind(n) === 'keyboard') out.add(n);
  }
  return out;
}

function screenNodes(nodes: Node[]): Node[] {
  const kb = keyboardNodes(nodes);
  return nodes.filter((n) => !isRoot(n) && !kb.has(n));
}

// A hardware keyboard leaves the software one laid out below the screen: only one that overlaps the
// viewport is up.
const keyboardUp = (nodes: Node[], vp: Viewport): boolean => nodes.some((n) => kind(n) === 'keyboard' && onScreen(n, vp));

const LETTER = /[\p{L}\p{Nl}\p{No}]/u;
const BAR = /(tab|tool|nav\w*)[-_ ]?bar/;
const chars = (s: string): string[] => Array.from(s);

function summaryLabels(screen: Node[], vp: Viewport, scale: number): string[] {
  const area = vp ? vp[2] * vp[3] : 0;
  const picked: Array<[number, number, string]> = [];
  for (const n of screen) {
    const label = clean(n.label);
    if (!label || !LETTER.test(label) || scrollIndicator(n)) continue;
    const k = kind(n);
    // Two letters are an avatar's initials or a badge, unless something can be pressed there (OK).
    if (chars(label).length < 3 && (k === 'text' || k === 'other') && !typeOf(n).toLowerCase().includes('button')) continue;
    if (k === 'image' || !onScreen(n, vp)) continue;
    // A bar names itself (« Barre d'onglets », « Tab Bar »): its tabs say more, and come later.
    if (BAR.test(typeOf(n).toLowerCase())) continue;
    const r = rect(n);
    if (r) {
      // A wrapper the size of the screen names the screen's container, not something read.
      if (area && r[2] * r[3] >= 0.8 * area) continue;
      if (k !== 'text' && k !== 'field' && Math.max(r[2], r[3]) <= ICON_EDGE * scale) continue;
    }
    picked.push([pyRound((r ? r[1] : 0) / (4 * scale)), r ? r[0] : 0, label]);
  }
  picked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: string[] = [];
  for (const [, , label] of picked) {
    if (out.includes(label)) continue;
    out.push(label);
    if (out.length === MAX_LABELS) break;
  }
  return out.map((l) => (chars(l).length <= MAX_LABEL_CHARS ? l : `${pyRstrip(chars(l).slice(0, MAX_LABEL_CHARS - 1).join(''))}…`));
}

const keys = (screen: Node[]): string[] => screen.map((n) => `${pyStr(n.type)}|${clean(n.label)}|${pyStr(n.identifier)}`);

// (added, removed) between two key lists, each key matched once.
function delta(prev: string[], cur: string[]): [number, number] {
  const left = new Map<string, number>();
  for (const k of prev) left.set(k, (left.get(k) ?? 0) + 1);
  let added = 0;
  for (const k of cur) {
    const c = left.get(k) ?? 0;
    if (c) left.set(k, c - 1);
    else added++;
  }
  let removed = 0;
  for (const c of left.values()) removed += c;
  return [added, removed];
}

// Android names the focused field; its label is then what it holds (the hint only while it is
// empty), and a password field is named as one rather than read out.
function focused(screen: Node[]): string {
  for (const n of screen) {
    if (n.focused && kind(n) === 'field') {
      if (n.password) return 'password';
      return chars(clean(n.label)).slice(0, MAX_LABEL_CHARS).join('') || clean(n.identifier) || 'field';
    }
  }
  return '';
}

export interface LineOptions {
  prev?: string;
  save?: string;
  keyboard?: string;
  scale?: number;
}

// « screen: <≤ 6 labels> (<n> nodes, +added −removed, keyboard, focus "<field>") », and the exit code.
export function screenLine(snap: Snapshot, o: LineOptions = {}): { line: string; code: number } {
  const { nodes } = snap;
  if (!nodes) return { line: 'screen: (nothing readable)', code: 2 };
  const scale = o.scale || 1;
  const vp = viewport(nodes);
  const screen = screenNodes(nodes);
  const labels = summaryLabels(screen, vp, scale);
  const cur = keys(screen);
  const facts = [`${cur.length} nodes`];
  if (o.prev) {
    try {
      const before = readFileSync(o.prev, 'utf8')
        .replace(/\r\n?/g, '\n')
        .split(/(?<=\n)/)
        .filter((l) => pySplit(l).length)
        .map((l) => l.replace(/\n$/, ''));
      const [added, removed] = delta(before, cur);
      facts.push(`+${added} −${removed}`);
    } catch {
      // No previous snapshot: the first line of a command counts from nothing.
    }
  }
  if (o.save) writeFileSync(o.save, `${cur.join('\n')}\n`);
  const keyboard = o.keyboard ?? 'auto';
  if (keyboard === 'yes' || (keyboard === 'auto' && keyboardUp(nodes, vp))) facts.push('keyboard');
  const field = focused(screen);
  if (field) facts.push(`focus "${field}"`);
  // A notification shade, a permission prompt, an « app not responding » dialog: what the tree shows
  // is not the app, and the step that follows has to deal with that first.
  const android = snap.data.androidSnapshot;
  if (isObject(android) && android.systemSurfaceOnly) facts.push('system dialog over the app');
  return { line: `screen: ${labels.join(' · ') || '(no label)'} (${facts.join(', ')})`, code: 0 };
}

const matches = (node: Node, needle: string): boolean => [node.label, node.value].some((v) => casefold(clean(v)).includes(needle));

// 0 when the text is on screen (its centre inside and nothing over it, with `visible`), 1 when not.
export function screenHas(snap: Snapshot, text: string, visible = false): number {
  const { nodes } = snap;
  if (!nodes) return 2;
  const vp = viewport(nodes);
  const needle = casefold(clean(text));
  for (const n of screenNodes(nodes)) {
    if (!matches(n, needle)) continue;
    if (!visible && onScreen(n, vp)) return 0;
    // iOS marks what a bar or a sheet is drawn over: it is on screen, not reachable.
    const hints = n.presentationHints;
    const covered = Array.isArray(hints) ? hints.includes('covered') : typeof hints === 'string' && hints.includes('covered');
    if (visible && onScreen(n, vp, true) && !covered) return 0;
  }
  return 1;
}

// The labels on screen as one string (null: unreadable). Two equal in a row: a screen at rest.
export function screenSig(snap: Snapshot, geometry = false): string | null {
  const { nodes } = snap;
  if (!nodes) return null;
  const vp = viewport(nodes);
  const parts: string[] = [];
  for (const n of screenNodes(nodes)) {
    if (!onScreen(n, vp)) continue;
    let part = clean(n.label);
    // Where things sit, too: a scroll moves every row and may leave the same ones on screen.
    const r = rect(n);
    if (geometry && r) part += `@${pyRound(r[0])},${pyRound(r[1])}`;
    parts.push(part);
  }
  return parts.sort(byCodePoint).join('\x1f');
}

const centre = (node: Node): string => {
  const [x, y, w, h] = rect(node)!;
  return `${pyRound(x + w / 2)} ${pyRound(y + h / 2)}`;
};

// « x y » of the field a label names, « x y only » for the one unlabelled field; null when none.
export function screenField(snap: Snapshot, label: string): { out: string | null; code: number } {
  const { nodes } = snap;
  if (!nodes) return { out: null, code: 2 };
  const vp = viewport(nodes);
  const needle = casefold(clean(label));
  const screen = screenNodes(nodes);
  const fields = screen.filter((n) => kind(n) === 'field' && rect(n) && onScreen(n, vp));
  for (const n of fields) if (matches(n, needle) || casefold(clean(n.identifier)).includes(needle)) return { out: centre(n), code: 0 };
  // A form label is a text of its own above the field (« E-mail », then the box): the nearest field
  // starting below it, overlapping it horizontally, is the one it names.
  let best: [number, Node] | null = null;
  for (const t of screen) {
    const tr = rect(t);
    if (kind(t) === 'field' || !tr || !matches(t, needle)) continue;
    const [tx, ty, tw] = tr;
    for (const f of fields) {
      const [fx, fy, fw, fh] = rect(f)!;
      if (fy + fh / 2 < ty || fx > tx + tw || fx + fw < tx) continue;
      const gap = fy - ty;
      if (best === null || gap < best[0]) best = [gap, f];
    }
  }
  if (best) return { out: centre(best[1]), code: 0 };
  // iOS does not hand a text input's placeholder to the tree: « Rechercher une conversation » is on
  // screen and nowhere in the snapshot. With one field on screen there is nothing to confuse it with,
  // and the caller says which one it took.
  if (fields.length === 1 && !clean(fields[0]!.label)) return { out: `${centre(fields[0]!)} only`, code: 0 };
  return { out: null, code: 1 };
}

// 0 when a text field is on screen, 1 when none.
export function screenEditable(snap: Snapshot): number {
  const { nodes } = snap;
  if (!nodes) return 2;
  const vp = viewport(nodes);
  return screenNodes(nodes).some((n) => kind(n) === 'field' && onScreen(n, vp)) ? 0 : 1;
}

export async function main(argv: string[], io: Io): Promise<number> {
  if (argv.length < 2) {
    io.err(DOC);
    return 2;
  }
  const [cmd, path, ...rest] = argv as [string, string, ...string[]];
  if (cmd === 'line') {
    const opts: Record<string, string> = { '--prev': '', '--save': '', '--keyboard': 'auto', '--scale': '1' };
    for (let i = 0; i < rest.length; i += 2) {
      if (!(rest[i]! in opts) || i + 1 >= rest.length) {
        io.err(`screen line: unknown option ${rest[i]}\n`);
        return 2;
      }
      opts[rest[i]!] = rest[i + 1]!;
    }
    const scale = pyFloat(opts['--scale']!) || 1;
    const r = screenLine(readSnapshot(path), { prev: opts['--prev'], save: opts['--save'], keyboard: opts['--keyboard'], scale });
    io.out(`${r.line}\n`);
    return r.code;
  }
  if (cmd === 'has' && rest.length) return screenHas(readSnapshot(path), rest[0]!, rest.slice(1).includes('--visible'));
  if (cmd === 'sig') {
    const sig = screenSig(readSnapshot(path), rest.includes('--geometry'));
    if (sig === null) return 2;
    io.out(`${sig}\n`);
    return 0;
  }
  if (cmd === 'field' && rest.length) {
    const r = screenField(readSnapshot(path), rest[0]!);
    if (r.out !== null) io.out(`${r.out}\n`);
    return r.code;
  }
  if (cmd === 'editable') return screenEditable(readSnapshot(path));
  io.err(DOC);
  return 2;
}
