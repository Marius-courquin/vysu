// `vysu report <name> [--md [--out <file>]]`: a shots folder read back in 25 lines at most — what changed, what to
// open, and the pictures that did not move named so nobody opens them.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { metaRead, type Meta } from '../core/meta.ts';
import { pyFixed } from '../core/py.ts';

type Verdict = Record<string, unknown>;

// What Python's str() made of a JSON value, which is what the report always printed.
function py(v: unknown): string {
  if (v === undefined || v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}
const truthy = (v: unknown): boolean =>
  !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0));
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join('');
const mtime = (p: string): number => statSync(p).mtimeMs;
const readLines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/) : []);

const USAGE = 'usage: vysu report <name> [--md [--out <file>]]';

export async function run(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) die(USAGE);
  let md = false;
  let file = '';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--md') md = true;
    else if (args[i] === '--out' && i + 1 < args.length) file = args[++i]!;
    else die(`vysu report: unknown option ${args[i]}`);
  }
  if (file && !md) md = true;
  const dir = join(config().shots, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`no shots folder ${dir}`);
  const lines = report(dir);
  const out = md ? ['```', ...lines, '```'] : lines;
  process.stdout.write(`${out.join('\n')}\n`);
  // Checkers wrote « --md printed its Markdown and wrote no file » and pointed at a file that was not
  // there: the Markdown is kept beside the captures too, and its path said on stderr, out of the
  // block an agent pastes.
  if (md) {
    const path = file ? resolve(file) : join(dir, 'report.md');
    writeFileSync(path, `${out.join('\n')}\n`);
    process.stderr.write(`report: ${path}\n`);
  }
}

export function report(dir: string): string[] {
  const meta = metaRead(dir);
  return meta.kind === 'mobile' ? mobileReport(dir, meta) : webReport(dir, meta);
}

// A mobile folder: what the device was set to, then one line per capture with the verdict its last
// mshot recorded (vs previous, vs a baseline), then the one image worth opening.
function mobileReport(dir: string, meta: Meta): string[] {
  const lines: string[] = [];
  const name = basename(dir);
  const recorded = (meta.verdicts as Record<string, Verdict> | undefined) ?? {};
  const verdicts: Record<string, Verdict> = { ...recorded };
  // A folder an older vysu diffed against a baseline has diff.txt only: its statuses stand in.
  let label: string | undefined;
  for (const raw of readLines(join(dir, 'diff.txt'))) {
    if (raw.trim() && !raw.startsWith(' ')) {
      const at = raw.indexOf(': ');
      label = at < 0 ? raw : raw.slice(0, at);
      const rest = at < 0 ? '' : raw.slice(at + 2);
      if (!(label in recorded)) verdicts[label] = { vs: 'baseline', verdict: rest };
    } else if (raw.trim().startsWith('marked:') && label !== undefined && label in verdicts && !(label in recorded)) {
      verdicts[label]!.marked = raw.split('marked:').slice(1).join('marked:').trim();
    }
  }
  const head: unknown[] = ['mobile', meta.platform, meta.device];
  for (const key of ['textsize', 'lang', 'appearance']) if (truthy(meta[key])) head.push(`${key} ${py(meta[key])}`);
  if (truthy(meta.mobile_sha)) head.push(`sha ${py(meta.mobile_sha)}`);
  if (truthy(meta.date)) head.push(cut(String(meta.date), 16).replace('T', ' '));
  lines.push(head.filter(truthy).map(py).join(' · '));

  const files = readdirSync(dir);
  const isCapture = (f: string): boolean =>
    f.endsWith('.png') &&
    !f.startsWith('.') &&
    !f.startsWith('sheet') &&
    !f.startsWith('compare') &&
    !f.endsWith('.prev.png') &&
    !f.endsWith('-changed.png') &&
    !f.endsWith('-base.png');
  const shots = files.filter(isCapture).sort((a, b) => mtime(join(dir, a)) - mtime(join(dir, b)));
  const lab = (f: string): string => f.slice(0, -4);

  const lineOf = (f: string): string => {
    const v = verdicts[lab(f)];
    if (!truthy(v)) return `${lab(f)}: not compared`;
    const where = truthy(v!.device) && v!.device !== meta.device ? ` [${py(v!.device)}]` : '';
    if (!truthy(v!.vs)) return `${lab(f)}${where}: ${py(v!.verdict)}`;
    let text = truthy(v!.verdict) ? py(v!.verdict) : '?';
    if (truthy(v!.zones)) text += ` (${(v!.zones as unknown[]).map(py).join(' · ')}${truthy(v!.more) ? ` · +${Math.trunc(Number(v!.more))}` : ''})`;
    if (truthy(v!.size)) text = `size ${py(v!.size)}, ${text}`;
    return `${lab(f)}${where}: vs ${py(v!.vs)} · ${text}`;
  };

  const changed = shots.filter((f) => {
    const m = verdicts[lab(f)]?.marked;
    return truthy(m) && existsSync(String(m));
  });
  const closing: string[] = [];
  if (changed.length) {
    const at = (f: string): string => (truthy(verdicts[lab(f)]!.at) ? String(verdicts[lab(f)]!.at) : '');
    const latest = changed.reduce((best, f) => (at(f) > at(best) ? f : best));
    closing.push(`read: ${py(verdicts[lab(latest)]!.marked)}`);
    if (changed.length > 1) closing.push(`changed: ${changed.length} captures, all marked in one image: vysu sheet ${name} --only '*-changed.png'`);
  } else if (shots.length === 1) {
    closing.push(`read: ${join(dir, shots[0]!)}`);
  } else if (shots.length) {
    const sheets = files.filter((f) => f.startsWith('sheet') && f.endsWith('.png') && f !== 'sheet-strip.png').sort();
    const newest = Math.max(...shots.map((f) => mtime(join(dir, f))));
    if (sheets.length && Math.min(...sheets.map((f) => mtime(join(dir, f)))) >= newest) {
      closing.push(...sheets.slice(0, 5).map((f) => `read: ${join(dir, f)}`));
      if (sheets.length > 5) closing.push(`… ${sheets.length - 5} more sheet page(s), all in ${join(dir, 'index.html')}`);
    } else {
      closing.push(`sheet: vysu sheet ${name}`);
    }
  } else {
    closing.push(`no capture in ${dir}`);
  }

  if (shots.length && !shots.some((f) => lab(f) in verdicts)) {
    // Nothing was ever compared here (captured before verdicts existed, or by hand): one line naming
    // them beats a screenful of « not compared ».
    const names = shots.map(lab).join(', ');
    lines.push(`${shots.length} capture(s), none compared: ${Array.from(names).length <= 200 ? names : `${cut(names, 199)}…`}`);
  } else {
    // 25 lines at most: the header and the closing lines are kept, a changed capture is never the
    // one folded away, and what is folded is counted by verdict.
    const room = 25 - 1 - closing.length;
    let shown = shots;
    if (shots.length > room) {
      const keep = new Set(changed.slice(-(room - 1)));
      for (const f of [...shots].reverse()) {
        if (keep.size >= room - 1) break;
        keep.add(f);
      }
      shown = shots.filter((f) => keep.has(f));
    }
    const folded = shots.filter((f) => !shown.includes(f));
    if (folded.length) {
      const counts = new Map<string, number>();
      for (const f of folded) {
        const v = verdicts[lab(f)]?.verdict;
        const key = truthy(v) ? py(v) : 'not compared';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      lines.push(`${folded.length} earlier capture(s) not listed: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}`);
    }
    lines.push(...shown.map(lineOf));
  }
  lines.push(...closing);
  return lines;
}

function webReport(dir: string, meta: Meta): string[] {
  let lines: string[] = [];
  const head: unknown[] = ['kind' in meta ? meta.kind : 'shots', meta.persona, truthy(meta.url) ? meta.url : meta.device];
  if (truthy(meta.lang)) head.push(`lang ${py(meta.lang)}`);
  for (const [key, label] of [
    ['sizes', 'size'],
    ['schemes', 'scheme'],
  ] as const) {
    const v = meta[key];
    if (truthy(v)) {
      const n = Array.isArray(v) ? v.length : String(v).length;
      head.push(`${n} ${label}${n > 1 ? 's' : ''}`);
    }
  }
  for (const key of ['textsize', 'appearance']) if (truthy(meta[key])) head.push(`${key} ${py(meta[key])}`);
  if (truthy(meta.baseline_url)) head.push(`vs ${py(meta.baseline_url)}`);
  else if (truthy(meta.baseline)) head.push(`vs ${py(meta.baseline)}`);
  const sha = truthy(meta.web_sha) ? meta.web_sha : meta.mobile_sha;
  if (truthy(sha)) head.push(`sha ${py(sha)}${truthy(meta.web_branch) ? ` (${py(meta.web_branch)})` : ''}`);
  if (truthy(meta.api)) head.push(`api ${py(meta.api)}`);
  if (truthy(meta.date)) head.push(cut(String(meta.date), 16).replace('T', ' '));
  lines.push(head.filter(truthy).map(py).join(' · '));

  // A recording: the one line saying the clip is machine-readable, so `vysu cut` is the next command.
  if (truthy(meta.events)) {
    try {
      const ev = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8'));
      const steps = Array.isArray(ev.steps) ? ev.steps.length : 0;
      lines.push(`clip: ${'clip' in ev ? py(ev.clip) : ''} · ${pyFixed(Number(ev.duration || 0), 1)} s · ${steps} steps (events.json)`);
    } catch {
      // a take without events.json reads like a capture
    }
  }

  // diff.txt: one « <label>: … » line per capture, its zones indented under it, « marked: <path> »
  // naming the image to open.
  const status = new Map<string, string>();
  const marked = new Map<string, string>();
  const zones: Array<[string | undefined, string]> = [];
  let label: string | undefined;
  for (const raw of readLines(join(dir, 'diff.txt'))) {
    if (!raw.trim()) continue;
    if (!raw.startsWith(' ')) {
      const at = raw.indexOf(': ');
      label = at < 0 ? raw : raw.slice(0, at);
      status.set(label, at < 0 ? '' : raw.slice(at + 2));
    } else if (raw.trim().startsWith('marked:')) {
      marked.set(String(label), raw.split('marked:').slice(1).join('marked:').trim());
    } else {
      zones.push([label, raw.trimEnd()]);
    }
  }
  for (const [lab, s] of status) lines.push(`${lab}: ${s}`);
  const zoneAt = lines.length;
  lines.push(...zones.map(([lab, text]) => `  ${py(lab)} ${text.trim()}`));

  // check.txt: « ## <what> » sections, « (none) » when there is nothing to say.
  const check = join(dir, 'check.txt');
  if (existsSync(check)) {
    const sections = new Map<string, string[]>();
    let current: string | undefined;
    for (const raw of readFileSync(check, 'utf8').split(/\r?\n/)) {
      if (raw.startsWith('## ')) {
        current = raw.slice(3);
        sections.set(current, []);
      } else if (raw && raw !== '(none)' && current) {
        sections.get(current)!.push(raw);
      }
    }
    const bad = [...sections].filter(([, found]) => found.length);
    lines.push(bad.length ? `check: ${bad.map(([w, f]) => `${f.length} ${w}`).join(', ')}` : 'check: clean');
    for (const [, found] of bad) lines.push(...found.slice(0, 3).map((l) => `  ${cut(l, 160)}`));
  }

  const files = readdirSync(dir);
  const shots = files.filter((f) => f.endsWith('.png') && !f.startsWith('sheet') && !f.startsWith('compare')).sort();
  const compares = files.filter((f) => f.startsWith('compare') && f.endsWith('.png')).sort();
  const diffed = shots.some((f) => f.endsWith('-base.png') || f.endsWith('-changed.png'));
  // Naming the pictures that did not move is what keeps an agent from opening them.
  const quiet = shots.filter((f) => !f.endsWith('-changed.png') && (status.get(f.slice(0, -4)) ?? 'identical').startsWith('identical'));
  if (status.size && quiet.length) lines.push(`identical, do not read: ${quiet.join(', ')}`);
  let read = [...status.keys()].filter((l) => marked.has(l)).map((l) => marked.get(l)!);
  if (compares.length) {
    // A compare page carries the marked image already: it replaces it rather than adding to it.
    read = compares.map((f) => join(dir, f));
  } else if (diffed) {
    lines.push(`compare: vysu sheet ${basename(dir)} --compare`);
  }
  if (!status.size && !compares.length) {
    // Without a diff there is nothing to single out: the sheet is the one thing worth opening, and
    // four full-size captures are 7k tokens for the same picture.
    const sheets = files.filter((f) => f.startsWith('sheet') && f.endsWith('.png')).sort();
    read = sheets.map((f) => join(dir, f));
    if (!sheets.length) lines.push(`sheet: vysu sheet ${basename(dir)}`);
  }
  for (const p of read) lines.push(`read: ${p}`);

  if (lines.length > 25 && zones.length) {
    // Zone detail is the only part worth losing.
    const keep = Math.max(0, 25 - (lines.length - zones.length) - 1);
    if (keep < zones.length) {
      lines = [
        ...lines.slice(0, zoneAt + keep),
        `  … ${zones.length - keep} more zone(s) in ${dir}/diff.txt`,
        ...lines.slice(zoneAt + zones.length),
      ];
    }
  }
  return lines;
}
