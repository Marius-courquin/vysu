// The web verbs a flow is written in — go / click / fill / shot / check — and what a capture records
// about the page: which API it talked to, which language it is in.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die, VysuError } from '../core/errors.ts';
import { i18nLabel, langCheck } from '../core/i18n.ts';
import { lockTake, resourceOf } from '../core/hold.ts';
import { metaWrite, repoBranch, repoSha } from '../core/meta.ts';
import { ev } from '../core/rec.ts';
import { sleep } from '../core/text.ts';
import { ab, bboxes, bcmd, brun, evalValue, lastLine } from './ab.ts';
import { boxOfJs, chromeJs, EXPAND_JS, langReadJs, RESTORE_JS, WARM_JS } from './js.ts';
import { shellWords, StepSyntax } from './words.ts';

// Which API the page actually talked to. The state file only knows about a dev server vysu started
// itself, and one launched by hand outside vysu makes it lie: the session's own requests do not.
// The last request, not the first: with --baseline-url the baseline origin is captured first, and
// the page under test — the one the meta is about — is always the one captured last.
export async function webApi(persona: string): Promise<string> {
  const pattern = config().get('API_PATTERN');
  const r = await ab(persona, ['network', 'requests'], { stderr: 'drop' });
  let host = '';
  const re = new RegExp(`https?://([^/ ]+)${pattern}`, 'g');
  for (const m of r.stdout.matchAll(re)) host = m[1]!;
  if (!host) {
    try {
      return readFileSync(join(config().state, 'web.api'), 'utf8').replace(/\n+$/, '');
    } catch {
      return 'unknown';
    }
  }
  // `host=label` pairs: what a report calls that API, rather than the host an agent has to decode.
  for (const pair of config().get('API_HOSTS').split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if ((eq < 0 ? pair : pair.slice(0, eq)) === host) return eq < 0 ? pair : pair.slice(eq + 1);
  }
  return host;
}

// Read once per flow: only `click t:<key>` needs it.
let webLang = '';
export async function webLangInit(persona: string): Promise<void> {
  if (webLang) return;
  const js = langReadJs();
  if (js) webLang = evalValue((await ab(persona, ['eval', js], { stderr: 'drop' })).stdout);
  webLang ||= config().get('LANG');
}

// What a page needs before it can be captured, spent on a navigation only: a viewport change starts
// none, it just has to be given time to repaint (bsettle). The cap on networkidle is what makes it
// usable at all — a page that never goes quiet (an open stream, a poll) would otherwise hold the
// batch for 60 s, and agent-browser calls the wait a success either way, so --bail stays safe.
export const bsettle = (): void => bcmd('wait', '300');
// What the page under review must not show. Queued once per page: a hidden badge and an injected
// stylesheet survive a viewport change, only a navigation wipes them — so also queued for a scheme
// that opens nothing, which is the `vysu shots` of a page already on screen.
export const bchrome = (freeze: boolean): void => bcmd('eval', chromeJs(freeze));
// Around a --full capture, and around that one only: the boxes of an --ignore selector are measured
// after the expansion (the page they are cut out of is the expanded one) and the restore is queued
// right after the screenshot, so a viewport change never starts from a layout vysu itself stretched.
export function bexpand(): void {
  bcmd('eval', EXPAND_JS);
  bsettle();
}
export const bunexpand = (): void => bcmd('eval', RESTORE_JS);
// After the expansion — the document the warm-up walks is the one about to be captured — and before
// the --ignore boxes, which are then measured from the top the capture starts at.
export function bwarm(): void {
  bcmd('eval', WARM_JS);
  bsettle();
}
// Everything a fresh page needs before it can be captured.
export function bopen(url: string, lang: string, freeze: boolean): void {
  bcmd('open', url);
  // The language key is read at boot only: the page has to come back for the language to apply.
  const key = config().get('LANG_STORAGE_KEY');
  if (lang && key) {
    bcmd('eval', `localStorage.setItem('${key}', '${lang}')`);
    bcmd('reload');
  }
  bcmd('wait', '--load', 'networkidle', '--timeout', '2500');
  bsettle();
  bchrome(freeze);
}

// A batch whose failure is a step that failed, not the end of vysu: what agent-browser said is
// printed, and the step says so.
async function brunStep(persona: string): Promise<boolean> {
  const json = await brun(persona);
  try {
    bboxes(json);
    return true;
  } catch (e) {
    if (!(e instanceof VysuError)) throw e;
    process.stderr.write(`vysu: ${e.message}\n`);
    return false;
  }
}

// A navigation settled the way a capture needs it, devtools badges hidden.
export async function webGo(persona: string, url: string): Promise<boolean> {
  bcmd('open', url);
  bcmd('wait', '--load', 'networkidle', '--timeout', '2500');
  bsettle();
  bchrome(false);
  return brunStep(persona);
}

// Only when a recording is in flight, and never fatal: a box that cannot be found costs a ripple,
// not a step.
export async function webBoxOf(persona: string, label: string, field: boolean): Promise<string> {
  const r = await ab(persona, ['eval', boxOfJs(label, field)], { stderr: 'drop' });
  return evalValue(r.stdout);
}

// By button name, then by link name, then by visible text: the same label is a button on one screen
// and a link on the next, and a flow names what it sees rather than how it is marked up. A step that
// finds nothing says why and hands its failure back, rather than ending the command itself: the
// runner is then the one that names the step number, and a recording is stopped instead of left
// running.
export async function webClick(persona: string, label: string): Promise<boolean> {
  if (ev.rows) ev.target = await webBoxOf(persona, label, false);
  const tries = [
    ['find', 'role', 'button', 'click', '--name', label],
    ['find', 'role', 'link', 'click', '--name', label],
    ['find', 'text', label, 'click'],
  ];
  let done = false;
  for (const t of tries) {
    if ((await ab(persona, t, { stderr: 'drop' })).code === 0) {
      done = true;
      break;
    }
  }
  if (!done) {
    process.stderr.write(`vysu: nothing labelled « ${label} » (vysu ${persona} snapshot -i -c)\n`);
    return false;
  }
  return (await ab(persona, ['wait', '300'])).code === 0;
}

// By <label>, then by placeholder (a search box carries no label).
export async function webFill(persona: string, label: string, value: string): Promise<boolean> {
  if (ev.rows) ev.target = await webBoxOf(persona, label, true);
  for (const how of ['label', 'placeholder']) {
    if ((await ab(persona, ['find', how, label, 'fill', value], { stderr: 'drop' })).code === 0) return true;
  }
  process.stderr.write(`vysu: no field labelled « ${label} » (vysu ${persona} snapshot -i -c)\n`);
  return false;
}

// The page as it stands, into the shots folder: « <label> [--full] [--no-expand] ».
export async function webShot(persona: string, shots: string, rest: string): Promise<string> {
  if (!shots) die(`vysu: « shot ${rest} » needs --shots <name> (or a recording name)`);
  const words = rest.trim().split(/[ \t\n]+/).filter(Boolean);
  const label = words[0] ?? '';
  if (!label) die('vysu: « shot » needs a label');
  let full = false;
  let expand = true;
  for (const word of words.slice(1)) {
    if (word === '--full') full = true;
    else if (word === '--no-expand') expand = false;
    else die(`vysu: « shot ${label} » takes --full / --no-expand, not ${word}`);
  }
  if (!full) expand = false;
  const dir = join(config().shots, shots);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `web-${label}.png`);
  // Same three beats as a --full capture in `vysu shots`, one call each: a flow runs outside the batch.
  if (expand) {
    await ab(persona, ['eval', EXPAND_JS]);
    await ab(persona, ['wait', '300']);
  }
  await ab(persona, ['screenshot', ...(full ? ['--full'] : []), file]);
  if (expand) await ab(persona, ['eval', RESTORE_JS]);
  return file;
}

// A variable a step names (`fill "E-mail" "$VYSU_X"`), from what a flow has always seen: the
// config, the files it sources, the environment.
const stepVar = (name: string): string => config().values.get(name) ?? config().fileVars.get(name) ?? process.env[name] ?? '';

function words(step: string): string[] | null {
  try {
    return shellWords(step, stepVar);
  } catch (e) {
    if (!(e instanceof StepSyntax)) throw e;
    process.stderr.write(`vysu: « ${step} »: ${e.message}\n`);
    return null;
  }
}

// One line of a web flow / a recording: vysu's own verbs, then anything agent-browser accepts.
//   go <url> · click "<label>" · click t:<i18n.key> · fill "<label>" "<value>" · press <key>
//   · sleep <s> · shot <label> [--full] · check · viewport WxH   (`tap` reads as `click`, as on mobile)
// True when the step held; what failed has been said on stderr.
export async function webStep(persona: string, shots: string, step: string, print: (s: string) => void): Promise<boolean> {
  const after = (prefix: string): string => step.slice(prefix.length);
  if (step === '' || step.startsWith('#')) return true;
  if (step.startsWith('sleep ')) {
    const s = Number(after('sleep '));
    if (!(s >= 0)) {
      process.stderr.write(`vysu: sleep takes seconds, not « ${after('sleep ')} »\n`);
      return false;
    }
    await sleep(s * 1000);
    return true;
  }
  if (step.startsWith('go ')) return webGo(persona, after('go '));
  if (step.startsWith('viewport ')) {
    const wh = after('viewport ');
    const x = wh.lastIndexOf('x');
    const w = x < 0 ? wh : wh.slice(0, x);
    const h = wh.indexOf('x') < 0 ? wh : wh.slice(wh.indexOf('x') + 1);
    return (await ab(persona, ['set', 'viewport', w, h])).code === 0;
  }
  // By i18n key: the flow survives a wording change, and reads the same in every language.
  if (/^(click|tap) ["']?t:/.test(step)) {
    let key = step.slice(step.indexOf(' ') + 1);
    key = key.replace(/^["']/, '').replace(/["']$/, '').replace(/^t:/, '');
    await webLangInit(persona);
    ev.label = i18nLabel(webLang, key);
    return webClick(persona, ev.label);
  }
  if (step.startsWith('click ') || step.startsWith('tap ')) {
    const w = words(step.slice(step.indexOf(' ') + 1));
    return w !== null && webClick(persona, w[0] ?? '');
  }
  if (step.startsWith('fill ')) {
    const w = words(after('fill '));
    return w !== null && webFill(persona, w[0] ?? '', w[1] ?? '');
  }
  if (step.startsWith('press ')) return (await ab(persona, ['press', after('press ')])).code === 0;
  if (step.startsWith('shot ')) {
    print(`${await webShot(persona, shots, after('shot '))}\n`);
    return true;
  }
  if (step === 'check') {
    if (!shots) die('vysu: « check » needs --shots <name> (or a recording name)');
    const dir = join(config().shots, shots);
    mkdirSync(dir, { recursive: true });
    const out = await check(persona, '');
    print(out);
    appendFileSync(join(dir, 'check.txt'), out);
    return true;
  }
  const w = words(step);
  if (w === null) return false;
  const r = await ab(persona, w);
  if (r.stdout) print(`${lastLine(r.stdout)}\n`);
  return r.code === 0;
}

// What a web flow or a recording was taken against, in the file `vysu report` already reads.
export async function webMeta(dir: string, persona: string, extra: Record<string, string>): Promise<void> {
  const repo = config().webRepo;
  metaWrite(dir, {
    kind: 'web',
    persona,
    lang: webLang || config().get('LANG'),
    web_sha: repoSha(repo),
    web_branch: repoBranch(repo),
    api: await webApi(persona),
    ...extra,
  });
}

// JS errors and failed API requests of the session, one block of text (what `vysu check` prints and
// check.txt holds), then both lists cleared: each check covers what happened since the previous one.
export async function check(persona: string, save: string): Promise<string> {
  await lockTake(resourceOf(persona));
  const pattern = new RegExp(config().get('API_PATTERN'));
  const lines = ['## JS errors'];
  // The same error is thrown once per render: --json carries the message the plain output drops,
  // and one line per distinct message is all an agent can act on.
  const errs = await ab(persona, ['errors', '--json'], { stderr: 'drop' });
  const seen = new Map<string, number>();
  try {
    const d = JSON.parse(errs.stdout) as { data?: { errors?: Array<{ text?: string }> } };
    for (const e of d?.data?.errors ?? []) {
      const text = (e.text ?? '').trim() || '(empty)';
      seen.set(text, (seen.get(text) ?? 0) + 1);
    }
  } catch {
    // no answer: no error to list
  }
  for (const [text, n] of seen) lines.push(n === 1 ? text : `${text} (x${n})`);
  if (!seen.size) lines.push('(none)');
  lines.push('## failed API requests');
  const reqs = await ab(persona, ['network', 'requests'], { stderr: 'drop' });
  const failed = reqs.stdout
    .split('\n')
    .filter((l) => pattern.test(l) && !/ (2[0-9]{2}|304)$/.test(l) && !/^\[[0-9A-F]{32}\] OPTIONS/.test(l));
  lines.push(...(failed.length ? failed : ['(none)']));
  const out = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  // --save: the shots folder keeps it, so `vysu report` can say « clean » without a second call.
  if (save) {
    const dir = join(config().shots, save);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'check.txt'), out);
  }
  await ab(persona, ['network', 'requests', '--clear'], { stderr: 'drop' });
  await ab(persona, ['console', '--clear'], { stderr: 'drop' });
  return out;
}

// The web app's language, set where the app reads it, and the page brought back for it to apply.
export async function setLang(persona: string, lang: string): Promise<void> {
  const key = config().get('LANG_STORAGE_KEY');
  if (!key) die('vysu lang: this project stores no language (VYSU_LANG_STORAGE_KEY is empty)');
  langCheck(lang);
  bcmd('eval', `localStorage.setItem('${key}', '${lang}')`);
  bcmd('reload');
  bcmd('wait', '--load', 'networkidle', '--timeout', '2500');
  bboxes(await brun(persona));
}
