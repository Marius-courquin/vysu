// `vysu mshot`: one 1x capture of what the device shows (or a long screen walked through and
// stitched), kept beside the previous one of the same label and diffed against it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { devices, type Platform } from '../core/hold.ts';
import { metaWrite, repoSha } from '../core/meta.ts';
import { runBuffer } from '../core/proc.ts';
import { sleep } from '../core/text.ts';
import { tool } from '../img/tools.ts';
import { adCall, calls } from './agent.ts';
import { adb, adbShell, androidSelect, captureOptions, mobileScale, serial } from './device.ts';
import { lines, say, tell } from './io.ts';
import { pngSize } from './png.ts';
import { mstateGet } from './state.ts';
import { adbPath } from './tools.ts';
import { firstSentence } from './words.ts';

export const MSHOT_USAGE =
  'usage: vysu mshot ios|android <name> [label] [--baseline <name>] [--no-prev] [--full [--step 150] [--max 12] [--top <pt>] [--bottom <pt>]]';

// Android's status bar says the time: two captures a minute apart differ there, and a walk that
// crosses a minute leaves the stitcher no fixed band to find. The demo mode agent-device uses (9:41,
// no notification icons) is set for a capture and dropped after it, so the emulator is left as found;
// a --full walk holds it across all its frames. It shows at once: no settle needed.
const shotState = { demo: false, probe: '' };

async function androidDemo(on: boolean): Promise<void> {
  if (on) {
    await adb([
      'shell',
      'settings put global sysui_demo_allowed 1; am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941 >/dev/null; am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null',
    ]);
  } else {
    await adb(['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit']);
  }
}

// Why a keyboard went missing from Android captures: agent-device types through an input method of
// its own (com.callstack.agentdevice.imehelper) and leaves it selected for the rest of its session. A
// focused field then has a keyboard « shown » that draws nothing, and every capture, agent-device's or
// screencap's, is a screen no user sees: full height, no keyboard. Measured on a Pixel 8 (API 36):
// with Gboard selected both captures show Gboard, and both show the volume panel over the app. So when
// that helper holds a shown keyboard, the keyboard the user had is put back for the capture (the
// latest other one in the subtype history, else the first one installed that is not a voice input),
// and the helper right after it, so agent-device's next `fill` finds its own input method.
async function androidKeyboardSwap(): Promise<[string, string] | null> {
  // « shown » and « bound visible » both: right after a field goes away, mInputShown stays true a
  // moment while nothing is bound any more, and a swap then would only wait for a keyboard.
  const info = (
    await adbShell([
      'settings get secure default_input_method; dumpsys input_method | grep -E "mInputShown|mVisibleBound" | tr -d " \\n"; echo; settings get secure input_methods_subtype_history; ime list -s',
    ])
  ).split('\n');
  const cur = info[0] ?? '';
  if (!cur.includes('agentdevice')) return null;
  const shown = info[1] ?? '';
  if (!/mVisibleBound=true.*mInputShown=true|mInputShown=true.*mVisibleBound=true/.test(shown)) return null;
  const history = (info[2] ?? '').split(':').map((x) => x.split(';')[0] ?? '');
  const candidates = [...history, ...info.slice(3)].flatMap((x) => x.split(/\s+/));
  for (const ime of candidates) {
    if (!ime || ime === 'null' || ime.includes('agentdevice') || /[Vv]oice/.test(ime)) continue;
    return [cur, ime];
  }
  return null;
}

// Android goes through `screencap` of the display, brought down to dp here: the same picture
// agent-device's screenshot takes (it runs screencap too, under the same demo-mode status bar), minus
// its fixed one-second settle: 0.4 s instead of 1.9 s on a Pixel 8, which a --full walk pays once per
// frame. A keyboard is drawn in both (see androidKeyboardSwap).
async function androidCapture(out: string): Promise<void> {
  await androidSelect();
  const scale = await mobileScale('android');
  // A --full walk is about the content under the keyboard, not the keyboard: no swap per frame.
  const swap = shotState.demo ? null : await androidKeyboardSwap();
  if (swap) {
    await adb(['shell', 'ime', 'set', swap[1]]);
    // The keyboard window comes up about a second after the switch, then slides in.
    for (let i = 0; i < 12; i++) {
      if ((await adbShell(['dumpsys window InputMethod | grep isOnScreen'])).includes('true')) break;
      await sleep(100);
    }
    await sleep(400);
  }
  if (!shotState.demo) await androidDemo(true);
  const png = await runBuffer(adbPath(), ['-s', serial.value, 'exec-out', 'screencap', '-p']);
  const r = await tool('screencap', ['--scale', scale, '--out', out], { input: png.stdout });
  if (!shotState.demo) await androidDemo(false);
  if (swap) await adb(['shell', 'ime', 'set', swap[0]]);
  if (r.code !== 0) die(`android: screencap failed on ${serial.value}`);
}

// One 1x capture of what the device shows. iOS goes through agent-device (1x already, clock and bars
// repainted); Android through screencap.
export async function mshotCapture(p: Platform, out: string): Promise<void> {
  if (p === 'android') return androidCapture(out);
  const a = await adCall(p, calls.screenshot(out, await captureOptions(p)));
  if (!a.ok) die(`${p}: screenshot: ${a.error.code ? `${a.error.code}: ` : ''}${firstSentence(a.error.message ?? 'failed')}`);
}

// agent-device captures the viewport of a native app, never the screen: there is no full-page
// screenshot on mobile, so a long screen is walked through instead — a capture, a scroll, the next
// capture — until two captures come back identical (the scroller is at the end) or --max is reached,
// and the stitcher puts the pieces back together under the name the single capture would have had.
// The pieces stay in `full-frames/`: a seam worth doubting is read there, and at 1x they cost next to
// nothing to keep.
async function mshotFull(p: Platform, dir: string, shot: string, stepIn: string, max: number, top: string, bottom: string): Promise<string> {
  const frames = join(dir, 'full-frames');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  if (p === 'android') {
    await androidSelect();
    await androidDemo(true);
    shotState.demo = true;
  }
  const f = (i: number): string => join(frames, `f${String(i).padStart(2, '0')}.png`);
  await mshotCapture(p, f(0));
  shotState.probe = f(0); // the notch band is measured on a viewport, not on the tall image
  // A step has to leave two captures something in common — that overlap is what the stitcher locates
  // the next one by. What the gesture asks for is not what the content does: agent-device's scroll
  // stops being proportional past ~200 pt, where it becomes a flick that always lands the same
  // distance away (587 pt on a recent iPhone, whether --pixels says 250, 300 or 393), while 150 moved
  // it by 101. Hence 150 pt by default on both platforms: asking for more buys no ground and thins the
  // evidence the stitcher aligns on — a list of near-identical rows matches at several offsets, and
  // `ambiguous` or dropped captures is what that looks like.
  const step = Number(stepIn || '150');
  let n = 0;
  let prev = f(0);
  let ended = false;
  for (let i = 1; i <= max - 1; i++) {
    if (!(await adCall(p, calls.scroll('down', { pixels: step, settle: true }))).ok) {
      tell(`vysu: ${p}: scroll refused after ${n} step(s) — nothing scrollable on this screen?`);
      ended = true;
      break;
    }
    n = i;
    const cur = f(i);
    await mshotCapture(p, cur);
    // The same picture twice: the scroller did not move, so the screen has nothing left to show. By
    // pixels, not by bytes — two captures of one still screen come back as different PNG files
    // (agent-device re-encodes each one) while being the very same image, and a byte compare would
    // never end the walk. The diff answers with its exit code: 0 identical, 1 zones.
    if (readFileSync(prev).equals(readFileSync(cur)) || (await tool('diff', [prev, cur])).code === 0) {
      rmSync(cur, { force: true });
      ended = true;
      break;
    }
    prev = cur;
  }
  if (shotState.demo) {
    await androidDemo(false);
    shotState.demo = false;
  }
  if (!ended) tell(`vysu: mshot --full stopped at --max ${max} captures (the screen may be longer)`);
  // The stitcher finds the fixed bands itself, by taking the rows every capture has in common. A bar
  // drawn *over* the scroller has none — a shell that blurs the feed under its status bar and its
  // floating tab bar has those rows change with what scrolls beneath them, and the detection comes
  // back « top 0 px · bottom 0 px ». The overlap is then judged on blurred rows and no capture
  // matches: that is the screen to pass --top / --bottom for.
  const sargs = [...(top ? ['--top', top] : []), ...(bottom ? ['--bottom', bottom] : [])];
  const r = await tool('stitch', [frames, '--out', shot, ...sargs]);
  const said = `${r.stdout}${r.stderr}`.replace(/\n+$/, '');
  if (r.code !== 0) die(`stitch: ${said}`);
  // Back to where the screen was found, so the next command does not start halfway down it.
  if (!(await adCall(p, calls.scroll('top', { settle: true }))).ok) {
    for (let i = 0; i < n; i++) await adCall(p, calls.scroll('up', { pixels: step, settle: true }));
  }
  return said;
}

// What the diff leaves out of a mobile comparison: chrome, not UI. The battery corner on iOS:
// agent-device repaints the clock and the bars, not the battery, and the charging bolt animates, a
// 20x13 pt zone on every otherwise still screen. The band stops above the app: 44 pt under a notch
// (content starts at 59), 20 pt on a home-button phone. Measured on a viewport, which a --full capture
// no longer is, and whose aspect ratio is what tells a notch from a home button. The band sits at the
// top of the tall image all the same. Android's status bar is in demo mode for the capture: nothing to
// leave out.
function mshotIgnore(p: Platform): string[] {
  if (p !== 'ios') return [];
  const { width, height } = pngSize(shotState.probe);
  return ['--ignore', `${width - 70},0,70,${height > 2 * width ? 44 : 20}`];
}

// `printf '%s\n' "$text" | sed 's/^/  /'`: an empty text is one indented empty line.
const indent = (text: string): string => text.split('\n').map((l) => `  ${l}`).join('\n');

// A capture that would overwrite an earlier one under the same label moves it aside first
// (`<platform>-<label>.prev.png`) and is diffed against it: « vs previous: unchanged » is what says a
// fix that was announced did not reach the screen (a class that did not compile, a bundle that did
// not reload), before anyone reads the picture. One line, the marked image named when zones moved;
// the verdict is also kept in meta.json for `vysu report`. --no-prev overwrites and drops the earlier
// one. --baseline <name> compares with that folder instead, and prints what it always did.
export async function mshot(p: string, args: string[]): Promise<boolean> {
  const name = args[0] ?? '';
  if (!p || !name) die(MSHOT_USAGE);
  let rest = args.slice(1);
  let label = 'screen';
  if (rest[0] && !rest[0].startsWith('--')) {
    label = rest[0];
    rest = rest.slice(1);
  }
  let baseline = '';
  let full = false;
  let step = '';
  let max = 12;
  let top = '';
  let bottom = '';
  let noprev = false;
  for (let i = 0; i < rest.length; i++) {
    const v = (): string => rest[++i] ?? '';
    switch (rest[i]) {
      case '--baseline':
        baseline = v();
        break;
      case '--no-prev':
        noprev = true;
        break;
      case '--full':
        full = true;
        break;
      case '--step':
        step = v();
        break;
      case '--max':
        max = Number(v());
        break;
      case '--top':
        top = v();
        break;
      case '--bottom':
        bottom = v();
        break;
      default:
        die(`vysu mshot: unknown option ${rest[i]}`);
    }
  }
  if (p !== 'ios' && p !== 'android') die('platform must be ios or android');
  const shots = config().shots;
  let base = '';
  if (baseline) {
    base = join(shots, baseline, `${p}-${label}.png`);
    if (!existsSync(base)) die(`no baseline capture ${base}`);
  }
  const dir = join(shots, name);
  mkdirSync(dir, { recursive: true });
  const shot = join(dir, `${p}-${label}.png`);
  const prev = join(dir, `${p}-${label}.prev.png`);
  const marked = join(dir, `${p}-${label}-changed.png`);
  // Captured under a hidden name, then moved in place: a capture that fails leaves the earlier one
  // where it was, and a sheet or a report never reads half a file.
  const fresh = join(dir, `.${p}-${label}.new.png`);
  let stitch = '';
  if (full) stitch = (await mshotFull(p, dir, fresh, step, max, top, bottom)).replaceAll(fresh, shot);
  else await mshotCapture(p, fresh);
  let hadPrev = false;
  if (existsSync(shot) && !noprev) {
    renameSync(shot, prev);
    hadPrev = true;
  } else rmSync(prev, { force: true });
  renameSync(fresh, shot);
  rmSync(marked, { force: true }); // it marked the capture that was just replaced
  if (!full) shotState.probe = shot;
  say(shot);
  if (full) say(indent(stitch));
  const dev = devices.of(p);
  metaWrite(dir, {
    kind: 'mobile',
    platform: p,
    device: dev,
    ...(full ? { full: 'true' } : {}),
    textsize: mstateGet(p, 'textsize', 'normal'),
    appearance: mstateGet(p, 'appearance', 'light'),
    lang: mstateGet(p, 'lang', config().get('LANG')),
    mobile_sha: repoSha(config().mobileDir || config().projectDir),
  });
  const ign = mshotIgnore(p);
  const verdict = async (argv: string[], input?: string): Promise<boolean> => {
    const r = await tool('verdict', argv, input === undefined ? {} : { input });
    if (r.stdout) say(r.stdout.replace(/\n$/, ''));
    for (const l of lines(r.stderr)) tell(l);
    return r.code === 0;
  };
  const diff = async (a: string): Promise<string> => {
    const r = await tool('diff', [a, shot, '--mark', marked, ...ign]);
    const out = `${r.stdout}${r.stderr}`.replace(/\n+$/, '');
    if (r.code > 1) die(`diff: ${out}`);
    return out;
  };
  const label2 = `${p}-${label}`;
  if (base) {
    // Both captures are 1x, so the zones are already in points: no --scale to convert.
    const out = await diff(base);
    say(indent(out));
    appendFileSync(join(dir, 'diff.txt'), `${out.split('\n').map((l, i) => (i === 0 ? `${label2}: ${l}` : `  ${l}`)).join('\n')}\n`);
    return verdict([dir, label2, `baseline:${baseline}`, '--diff', '-', '--device', dev, '--quiet'], `${out}\n`);
  }
  if (hadPrev) {
    const out = await diff(prev);
    return verdict([dir, label2, 'previous', '--diff', '-', '--device', dev], `${out}\n`);
  }
  return verdict([dir, label2, noprev ? 'skipped' : 'new', '--device', dev]);
}
