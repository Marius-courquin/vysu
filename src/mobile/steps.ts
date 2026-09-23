// The verbs a mobile flow is written in, and the one runner that reads a step: `vysu mdo`, `mflow`,
// `mrec` and `mburst` all go through `mobileStep`. What a step answers is one line on stdout; why it
// failed is one line on stderr and a false.
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die, VysuError } from '../core/errors.ts';
import type { Platform } from '../core/hold.ts';
import { i18nLabel } from '../core/i18n.ts';
import { ev, now } from '../core/rec.ts';
import { sleep } from '../core/text.ts';
import { ad, adCall, calls, parseAnswer, type Answer, type Call } from './agent.ts';
import { lines, quiet, say, tell, why } from './io.ts';
import { mrelaunch } from './launch.ts';
import { mnet, mopen, mperm } from './mctl.ts';
import { mscreen, msnap, screenPy, snapFile, snapState } from './screen.ts';
import { mshot } from './shot.ts';
import { mstateGet } from './state.ts';
import { firstSentence, msOf, plainWords, pyG, secondsOk, shellWords, WordsError } from './words.ts';

const since = (t0: string): string => (Number(now()) - Number(t0)).toFixed(1);

// The point an answer acted on, for a recording's ripple: « x y ».
function target(d: Answer['data']): string {
  const x = d.x;
  const y = d.y;
  return typeof x === 'number' && typeof y === 'number' ? `${pyG(x)} ${pyG(y)}` : '';
}
const firstLine = (s: unknown): string => (typeof s === 'string' && s ? (s.split('\n')[0] ?? '') : '');

// Every press goes through --json: the answer carries the point that was hit (data.x / data.y), the
// only place a tap's coordinates ever exist, and a recording needs them to draw its ripple. The human
// line stays what it was — agent-device's own « Tapped label="…" (166, 822) ».
async function adPress(p: Platform, call: Call): Promise<string | null> {
  const a = await adCall(p, call);
  if (!a.ok) return null;
  ev.target = target(a.data);
  return firstLine(a.data.message);
}

// Any agent-device verb through --json: the first line of its message, the point it acted on in
// ev.target, and on failure its own error, so a step says « UNSUPPORTED_OPERATION: keyboard status …
// » rather than « failed ».
export interface Said {
  ok: boolean;
  line: string;
}
function said(a: Answer): Said {
  if (!a.ok) {
    const msg = firstSentence(a.error.message || 'failed');
    return { ok: false, line: a.error.code ? `${a.error.code}: ${msg}` : msg };
  }
  ev.target = target(a.data);
  return { ok: true, line: firstLine(a.data.message) };
}
export async function adJson(p: Platform, call: Call): Promise<Said> {
  return said(await adCall(p, call));
}
// The same for a verb given in agent-device's own words (`press 173 822`, `longpress @e3 800`).
async function adJsonRaw(p: Platform, args: string[]): Promise<Said> {
  const r = await ad(p, [...args, '--json']);
  return said(parseAnswer(r.stdout, r.code));
}
// Said as a step says it: the line, or its failure on stderr.
function answer(p: Platform, s: Said): boolean {
  if (s.ok) say(s.line);
  else why(`${p}: ${s.line}`);
  return s.ok;
}

// --- tap -----------------------------------------------------------------------------------------

export const MTAP_USAGE = 'usage: vysu mtap ios|android "<label>" [--wait "<text>"] [--timeout <s>]';

// Press by accessible label, else by visible text, else by the first element whose label contains it
// (a row announcing « title, description »), and settle. Nothing matched is a failed step, not the
// end of vysu — it says so and answers false, exactly like a web click: `mflow` still stops on the
// step that went wrong (with its number), while `mrec` reports it, plays the rest and keeps its clip.
// --wait "<text>" then waits for what the press was meant to bring (10 s, --timeout), and the answer
// stays one line: the press, then how long the text took.
export async function mtap(p: Platform, args: string[]): Promise<boolean> {
  const label = args[0] ?? '';
  if (!p || !label) die(MTAP_USAGE);
  let wait = '';
  let timeout = '10';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--wait') wait = args[++i] ?? '';
    else if (a === '--timeout') timeout = args[++i] ?? '';
    else {
      tell(`vysu: ${p}: tap takes --wait "<text>" and --timeout <s>, not ${a}`);
      return false;
    }
  }
  const pressed =
    (await adPress(p, calls.press(`label="${label}"`, { settle: true }))) ??
    (await adPress(p, calls.press(`text="${label}"`, { settle: true }))) ??
    (await adPress(p, calls.findPress(label)));
  if (pressed === null) {
    tell(`vysu: ${p}: nothing labelled « ${label} » (vysu ${p} snapshot -i)`);
    return false;
  }
  if (!wait) {
    say(pressed);
    return true;
  }
  const w = await waitText(p, wait, timeout);
  if (w.ok) {
    say(`${pressed} · ${w.line}`);
    return true;
  }
  say(pressed);
  tell(`vysu: ${p}: tapped, then no « ${wait} » after ${timeout}s`);
  return false;
}

// --- waits ---------------------------------------------------------------------------------------

// `wait "<text>"`: agent-device polls its own captures for a label or a value holding the text,
// case-insensitively — the primitive, rather than a snapshot loop of ours.
async function waitText(p: Platform, text: string, s = '10'): Promise<Said> {
  const t0 = now();
  if (!secondsOk(s)) return { ok: false, line: `wait takes seconds, not « ${s} »` };
  if ((await adCall(p, calls.waitText(text, msOf(s)))).ok) return { ok: true, line: `« ${text} » after ${since(t0)}s` };
  return { ok: false, line: `no « ${text} » after ${s}s` };
}
export async function mwaitText(p: Platform, text: string, s = '10'): Promise<boolean> {
  return answer(p, await waitText(p, text, s));
}

// has: 0 there, 1 not there, 2 nothing readable (the snapshot failed or the helper could not read it).
async function has(p: Platform, text: string, visible = false): Promise<number> {
  if (!(await msnap(p))) return 2;
  return (await screenPy(['has', snapFile(p), text, ...(visible ? ['--visible'] : [])])).code;
}
const past = (t0: string, s: string): boolean => Number(now()) - Number(t0) >= Number(s);

// `wait gone "<text>"`: the same matching as `wait "<text>"` (agent-device's `wait absent` takes an
// exact selector, which would make the two verbs disagree on what « the text » is), polled here.
export async function mwaitGone(p: Platform, text: string, s = '10'): Promise<boolean> {
  const t0 = now();
  if (!secondsOk(s)) return answer(p, { ok: false, line: `wait takes seconds, not « ${s} »` });
  snapState.fresh = true;
  for (;;) {
    if ((await has(p, text)) === 1) {
      say(`« ${text} » gone after ${since(t0)}s`);
      return true;
    }
    if (past(t0, s)) break;
    await sleep(300);
  }
  why(`${p}: « ${text} » still there after ${s}s`);
  return false;
}

// `wait idle`: two snapshots in a row with the same labels. A spinner turning or a skeleton
// shimmering does not count as movement; a list filling in, a screen swapping, a toast coming or going
// does.
export async function mwaitIdle(p: Platform, s = '10'): Promise<boolean> {
  const t0 = now();
  if (!secondsOk(s)) return answer(p, { ok: false, line: `wait idle takes seconds, not « ${s} »` });
  snapState.fresh = true;
  let prev = '';
  for (;;) {
    let cur = '';
    if (await msnap(p)) cur = (await screenPy(['sig', snapFile(p)])).out.replace(/\n$/, '');
    if (cur !== '' && cur === prev) {
      say(`idle after ${since(t0)}s`);
      return true;
    }
    prev = cur;
    if (past(t0, s)) break;
    await sleep(300);
  }
  why(`${p}: still moving after ${s}s`);
  return false;
}

// `scroll-to "<label>" [max]`: down, one settled scroll at a time, until the label's centre is on
// screen and nothing is drawn over it. A scroll that leaves the screen as it was is the end of the
// list, and there is no point in asking for the rest.
export async function mscrollTo(p: Platform, label = '', max = '8'): Promise<boolean> {
  if (!label) return answer(p, { ok: false, line: 'scroll-to needs a label' });
  if (!/^[0-9]+$/.test(max)) return answer(p, { ok: false, line: `scroll-to takes a number of scrolls, not « ${max} »` });
  const f = snapFile(p);
  snapState.fresh = true;
  let i = 0;
  let prev = '';
  let ended = '';
  for (;;) {
    await msnap(p);
    if ((await screenPy(['has', f, label, '--visible'])).code === 0) {
      say(`« ${label} » on screen after ${i} scroll(s)`);
      return true;
    }
    if (i >= Number(max)) break;
    const cur = (await screenPy(['sig', f, '--geometry'])).out.replace(/\n$/, '');
    if (i !== 0 && cur === prev) {
      ended = ' (the end of the list)';
      break;
    }
    prev = cur;
    if (!(await adCall(p, calls.scroll('down', { settle: true }))).ok) {
      ended = ' (scroll refused: nothing scrollable?)';
      break;
    }
    i++;
  }
  why(`${p}: no « ${label} » on screen after ${i} scroll(s)${ended}`);
  return false;
}

// `expect "<text>"` / `expect no "<text>"`: the current screen, now — no waiting (that is `wait`).
export async function mexpect(p: Platform, words: string[]): Promise<boolean> {
  let neg = false;
  let w = words;
  if (w[0] === 'no' && w.length >= 2) {
    neg = true;
    w = w.slice(1);
  }
  const text = w[0] ?? '';
  if (!text) return answer(p, { ok: false, line: 'expect needs a text' });
  snapState.fresh = true;
  const rc = await has(p, text);
  if (!neg && rc === 0) return answer(p, { ok: true, line: `« ${text} » on screen` });
  if (neg && rc === 1) return answer(p, { ok: true, line: `no « ${text} » on screen` });
  if (!neg && rc === 1) return answer(p, { ok: false, line: `no « ${text} » on screen` });
  if (neg && rc === 0) return answer(p, { ok: false, line: `« ${text} » is on screen` });
  return answer(p, { ok: false, line: 'nothing readable on screen' });
}

// `fill "<label>" "<value>"`: the field by its accessible label; else the field a label names on
// screen (its value, or the text above it: a form label is a node of its own); else press the label
// and type, for a field the tree does not describe as one; else, when the label is nowhere (iOS keeps
// a placeholder out of the tree), the one unlabelled field on screen, said as such.
export async function mfill(p: Platform, words: string[]): Promise<boolean> {
  const label = words[0] ?? '';
  const value = words[1];
  if (!label || value === undefined) return answer(p, { ok: false, line: 'usage: fill "<label>" "<value>"' });
  let s = await adJson(p, calls.fill(`label="${label}" editable=true`, value));
  if (s.ok) return answer(p, { ok: true, line: `${s.line} · label="${label}"` });
  await msnap(p);
  const xy = (await screenPy(['field', snapFile(p), label])).out.trim();
  const [x = '', y = '', how = ''] = xy.split(/\s+/);
  const point: [number, number] = [Number(x), Number(y)];
  if (xy && how !== 'only') {
    s = await adJson(p, calls.fill(point, value));
    if (s.ok) return answer(p, { ok: true, line: `${s.line} · the field of « ${label} » (${x}, ${y})` });
  }
  if (await quiet(() => mtap(p, [label]), { err: true })) {
    s = await adJson(p, calls.type(value));
    if (s.ok) return answer(p, { ok: true, line: `${s.line} · after pressing « ${label} »` });
  }
  if (how === 'only') {
    s = await adJson(p, calls.fill(point, value));
    if (s.ok) return answer(p, { ok: true, line: `${s.line} · no « ${label} » in the tree: the one field on screen (${x}, ${y})` });
  }
  return answer(p, { ok: false, line: `no field for « ${label} »` });
}

// `key return|dismiss|back`: the keyboard's return key, the keyboard put away, and back — the system
// back on Android, the app's own on iOS, which has no system one.
export async function mkey(p: Platform, key: string): Promise<boolean> {
  switch (key) {
    case 'return':
    case 'enter':
      return answer(p, await adJson(p, calls.keyboard('return')));
    case 'dismiss':
    case 'hide':
      return answer(p, await adJson(p, calls.keyboard('dismiss')));
    case 'back':
      return answer(p, await adJson(p, calls.back({ system: p === 'android', settle: true })));
    default:
      return answer(p, { ok: false, line: `key takes return, dismiss or back (not « ${key} »)` });
  }
}

// --- the runner ----------------------------------------------------------------------------------

function words(rest: string): string[] | null {
  try {
    return shellWords(rest);
  } catch (e) {
    if (!(e instanceof WordsError)) throw e;
    tell(`vysu: cannot read « ${rest} » (${e.message})`);
    return null;
  }
}

// An agent-device verb as written, its last line of output (`| tail -1`), its own exit status.
async function passthrough(p: Platform, args: string[]): Promise<boolean> {
  const r = await ad(p, args);
  const out = lines(r.stdout);
  if (out.length) say(out[out.length - 1]!);
  for (const l of lines(r.stderr)) tell(l);
  return r.code === 0;
}

// `wait` keeps agent-device's own forms (`wait 500` in ms, `wait text …`, `wait absent …`, `wait
// stable`, `wait @e3`, a selector) and adds the three a flow needs most.
async function mstepWait(p: Platform, rest: string): Promise<boolean> {
  const w = words(rest);
  if (!w) return false;
  const first = w[0] ?? '';
  if (first === 'gone') return mwaitGone(p, w[1] ?? '', w[2] ?? '10');
  if (first === 'idle') return mwaitIdle(p, w[1] ?? '10');
  if (first === '' || ['text', 'absent', 'stable'].includes(first) || first.startsWith('@') || first.includes('=')) return passthrough(p, ['wait', ...w]);
  if (/[^0-9]/.test(first)) return mwaitText(p, first, w[1] ?? '10');
  return passthrough(p, ['wait', ...w]);
}

// A matrix run of `vysu mdo` prefixes each capture « <device>-<textsize>- », and the runner lists the
// captures the steps wrote at the end.
export const shotRun = { prefix: '', taken: [] as string[] };

// One line of a flow / a recording: vysu's own verbs, then anything agent-device accepts.
//   sleep <s> · tap "<label>" [--wait "<text>"] [--timeout <s>] · tap t:<i18n.key> [--wait …]
//   wait "<text>" [<s>] · wait gone "<text>" [<s>] · wait idle [<s>] · fill "<label>" "<value>"
//   type "<text>" · key return|dismiss|back · scroll-to "<label>" [<max>] · expect [no] "<text>"
//   screen · shot <label> [--full] · relaunch [opts] · open <route> · net offline|online
//   perm <name> grant|deny|reset · press … · longpress … · any other agent-device verb
// A step's words are read the way a shell quotes them and are never expanded.
export async function mobileStep(p: Platform, shots: string, step: string): Promise<boolean> {
  snapState.fresh = false;
  const rest = (verb: string): string => step.slice(verb.length + 1);
  const is = (verb: string): boolean => step.startsWith(`${verb} `);
  if (step === '' || step.startsWith('#')) return true;
  if (is('sleep')) {
    const s = rest('sleep');
    if (!/^[0-9]*\.?[0-9]+$/.test(s.trim())) {
      tell(`sleep: invalid time interval '${s}'`);
      return false;
    }
    await sleep(Number(s) * 1000);
    return true;
  }
  // By i18n key: the flow survives a wording change, and reads the same in every language.
  if (/^tap ["']?t:/.test(step)) {
    const w = words(rest('tap'));
    if (!w) return false;
    const key = (w[0] ?? '').replace(/^t:/, '');
    try {
      ev.label = i18nLabel(mstateGet(p, 'lang', config().get('LANG')), key);
    } catch (e) {
      // A key the file does not hold is this step's failure; no locale folder at all is the flow's.
      if (!(e instanceof VysuError) || /VYSU_LOCALES/.test(e.message)) throw e;
      tell(`vysu: ${e.message}`);
      return false;
    }
    return mtap(p, [ev.label, ...w.slice(1)]);
  }
  if (is('tap')) {
    const w = words(rest('tap'));
    return w ? mtap(p, w) : false;
  }
  // A bare press / longpress is agent-device's own verb, and its answer holds the point it hit: worth
  // the same --json round-trip as a `tap`, so a recording gets a ripple out of it too, and a refusal
  // says why (« Android system dialog is blocking press »).
  if (is('press') || is('longpress')) {
    const w = words(step);
    return w ? answer(p, await adJsonRaw(p, w)) : false;
  }
  if (is('wait')) return mstepWait(p, rest('wait'));
  if (is('fill')) {
    const w = words(rest('fill'));
    return w ? mfill(p, w) : false;
  }
  if (is('type')) {
    const w = words(rest('type'));
    return w ? answer(p, await adJson(p, calls.type(w[0] ?? ''))) : false;
  }
  if (is('key')) return mkey(p, rest('key'));
  if (is('scroll-to')) {
    const w = words(rest('scroll-to'));
    return w ? mscrollTo(p, w[0], w[1]) : false;
  }
  if (is('expect')) {
    const w = words(rest('expect'));
    return w ? mexpect(p, w) : false;
  }
  if (step === 'screen') {
    say(await mscreen(p));
    return true;
  }
  if (is('open')) {
    const w = words(rest('open'));
    return w ? mopen(p, w) : false;
  }
  if (is('net')) {
    const w = words(rest('net'));
    return w ? mnet(p, w) : false;
  }
  if (is('perm')) {
    const w = words(rest('perm'));
    return w ? mperm(p, w) : false;
  }
  if (is('shot')) {
    if (!shots) die(`vysu: « ${step} » needs --shots <name> (or a recording name)`);
    const w = plainWords(rest('shot'));
    let label = w[0] ?? '';
    if (!label) die('vysu: « shot » needs a label');
    let full = false;
    for (const word of w.slice(1)) {
      if (word === '--full') full = true;
      else die(`vysu: « shot ${label} » takes --full, not ${word}`);
    }
    label = `${shotRun.prefix}${label}`;
    if (!(await mshot(p, [shots, label, ...(full ? ['--full'] : [])]))) return false;
    shotRun.taken.push(join(config().shots, shots, `${p}-${label}.png`));
    // A capture changes nothing on screen: the snapshot of the step before still describes it.
    snapState.fresh = true;
    return true;
  }
  if (step.startsWith('relaunch')) {
    const w = words(step.slice('relaunch'.length));
    if (!w) return false;
    await mrelaunch(p, w);
    return true;
  }
  const w = words(step);
  return w ? passthrough(p, w) : false;
}
