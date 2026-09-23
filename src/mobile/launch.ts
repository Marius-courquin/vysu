// Starting the app and waiting for it: expo or native, the dev-client handed this owner's Metro, the
// « Bundled » line, the ready text, and what stands between them (the dev menu, the launcher, a red
// box, a session to reopen). `vysu mrelaunch` is the whole of it.
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { iosLock, owner, type Platform } from '../core/hold.ts';
import { langCheck } from '../core/i18n.ts';
import { run } from '../core/proc.ts';
import { commaList, sleep } from '../core/text.ts';
import { adCall, calls, sessionClose, sessionName, sessionNames, type Answer } from './agent.ts';
import { applogStart } from './applog.ts';
import { adb, adbShell, androidSelect, iosUdid, serial, sim, waitAndroidBoot, waitAndroidShell } from './device.ts';
import { quiet, say, trace, why } from './io.ts';
import { bundleErrorSince, linesAfter, metroIsIsolated, metroLines, metroLog, metroNeed, metroPort, metroTag, metroUrl } from './metro.ts';
import { appearance, textsize } from './settings.ts';
import { hasExact, nodesOf, onDevMenu, onLauncher, redbox, redboxMessage } from './snap.ts';
import { mstateGet, mstateSet } from './state.ts';
import { crlf, xcrun } from './tools.ts';

// expo or native: everything that is Metro (the bundler, the dev-launcher hand-off, the « Bundled »
// line a relaunch waits for) happens in expo mode only. A native app — Swift, Kotlin, Flutter, .NET —
// is installed, launched and read through accessibility exactly like a dev-client; it just has no
// bundler in front of it, and its log comes from the platform instead of from Metro.
export function mobileKind(): 'expo' | 'native' {
  const kind = config().get('MOBILE_KIND', 'expo');
  if (kind !== 'expo' && kind !== 'native') die(`VYSU_MOBILE_KIND must be expo or native (got « ${kind} »)`);
  return kind;
}

export function mobileApp(p: Platform): string {
  return p === 'ios' ? config().get('IOS_APP') : config().get('MOBILE_BUNDLE');
}

// --- the agent-device session --------------------------------------------------------------------

// Is there an agent-device session on that device? Reading the tree needs one (`vysu <platform> open
// …`), and without it every snapshot is an immediate error: a wait that polls it would only burn its
// tries.
export async function sessionOpen(p: Platform): Promise<boolean> {
  return (await sessionNames()).includes(sessionName(p));
}

// Every agent-device call a wait makes is bounded, or a thrashing emulator turns a 60 s budget into
// eight minutes (seen: a relaunch that took 486 s). An iOS open may have to build the XCTest runner
// first, which is minutes on a loaded Mac; an Android open has nothing to build.
export const openTimeout = (p: Platform): number => (p === 'ios' ? 180000 : 60000);
export const SNAPSHOT_TIMEOUT = 15000;

// The session a snapshot needs, reopened quietly when it is gone (a daemon restart, a `close`): agents
// used to re-run `open --foreground` by hand after every relaunch. `open` without --relaunch only
// brings the running app forward; the first one on a new runtime builds agent-device's runner.
export async function sessionEnsure(p: Platform): Promise<boolean> {
  if (await sessionOpen(p)) return true;
  return (await adCall(p, calls.open(mobileApp(p), { timeoutMs: openTimeout(p) }))).ok;
}

const errorText = (a: Answer): string => `${a.error.code ?? ''}: ${a.error.message ?? ''} ${JSON.stringify(a.error.details ?? {})}`;

// A session bound to another device. An emulator restarted while another one held its port comes back
// on a new serial, and the session named after it still points at the old one: every command then
// fails with « already bound to … ». `agent-device close` with no app ends the session and closes no
// app (it only closes an app it is named), so dropping it and reopening is safe. When the serial is
// held by a session named after ANOTHER AVD of this project, that one is the same leftover seen from
// the other side (vysu binds a session to the serial of the AVD it is named after, and to nothing
// else), and it is dropped too.
export async function sessionRepair(p: Platform, said: string): Promise<boolean> {
  const name = sessionName(p);
  if (said.includes('is already bound to')) await sessionClose(name);
  const a = await adCall(p, calls.open(mobileApp(p), { timeoutMs: openTimeout(p) }));
  if (a.ok) return true;
  if (p !== 'android') return false;
  const other = /in use by session \\?"([^"\\]*)\\?"/.exec(errorText(a))?.[1] ?? '';
  if (!other.startsWith(`${config().get('PROJECT')}-android-`) || other === name) return false;
  await sessionClose(other);
  why(`android: dropped the session ${other}, left over on ${serial.value} from an emulator restart`);
  return (await adCall(p, calls.open(mobileApp(p), { timeoutMs: openTimeout(p) }))).ok;
}

// --- the dev-client ------------------------------------------------------------------------------

// Expo's dev menu opens on top of the app at launch until its first-run intro has been seen once, on
// every fresh install and on every simulator that never had it dismissed: 27 times in one audit. Its
// two preferences are set before the launch instead (expo-dev-menu 56: `EXDevMenuIsOnboardingFinished`
// / `EXDevMenuShowsAtLaunch` in the app's standard user defaults on iOS; `isOnboardingFinished` /
// `showsAtLaunch` in shared_prefs/expo.modules.devmenu.sharedpreferences.xml on Android). Written with
// the app stopped, since the app keeps its own copy while it runs. iOS goes through the simulator's
// own `defaults` on the container's plist path: its cfprefsd is the one the app reads from, where a
// plain write to the file could be overwritten by that daemon's cache. Android needs a debuggable build
// for `run-as`, which a dev-client is; a release build answers « not debuggable » and is left alone.
// The floating tools button goes too (`EXDevMenuShowFloatingActionButton` / `showFab`): it sat in
// every capture, over the app's top-right corner, and took the taps meant for what lay under it — a
// `tap Notifications` opened the dev menu instead. The menu itself stays a shake away.
export async function quietDevMenu(p: Platform, bundle: string): Promise<void> {
  if (p === 'ios') {
    const r = await xcrun(['simctl', 'get_app_container', await iosUdid(), bundle, 'data']);
    if (r.code !== 0) return;
    const plist = join(r.stdout.trim(), 'Library', 'Preferences', bundle);
    const get = async (k: string): Promise<string> => (await run('plutil', ['-extract', k, 'raw', `${plist}.plist`])).stdout.trim();
    if (
      (await get('EXDevMenuIsOnboardingFinished')) === 'true' &&
      (await get('EXDevMenuShowsAtLaunch')) === 'false' &&
      (await get('EXDevMenuShowFloatingActionButton')) === 'false'
    ) {
      return;
    }
    await sim('spawn', ['defaults', 'write', plist, 'EXDevMenuIsOnboardingFinished', '-bool', 'YES']);
    await sim('spawn', ['defaults', 'write', plist, 'EXDevMenuShowsAtLaunch', '-bool', 'NO']);
    await sim('spawn', ['defaults', 'write', plist, 'EXDevMenuShowFloatingActionButton', '-bool', 'NO']);
    return;
  }
  const prefs = 'shared_prefs/expo.modules.devmenu.sharedpreferences.xml';
  let cur = crlf((await adb(['shell', 'run-as', bundle, 'cat', prefs])).stdout).replace(/\n+$/, '');
  if (cur.includes('run-as:')) return; // not debuggable, or not installed
  const want = ['name="isOnboardingFinished" value="true"', 'name="showsAtLaunch" value="false"', 'name="showFab" value="false"'];
  if (want.every((w) => cur.includes(w))) return;
  if (!cur.includes('<map')) cur = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n</map>";
  const next = cur
    .split('\n')
    .filter((l) => !/name="(isOnboardingFinished|showsAtLaunch|showFab)"/.test(l))
    .map((l) =>
      l.replace(
        '</map>',
        '    <boolean name="isOnboardingFinished" value="true" />\n    <boolean name="showsAtLaunch" value="false" />\n    <boolean name="showFab" value="false" />\n</map>',
      ),
    )
    .join('\n');
  await adb(['shell', `run-as ${bundle} sh -c 'mkdir -p shared_prefs && cat > ${prefs}'`], { input: `${next}\n` });
}

// What happened in the last wait, for the caller's one line.
export const launchState = {
  handedAt: 0,
  bundledAt: 0,
  notReady: '',
  lang: '',
};
const nowS = (): number => Math.floor(Date.now() / 1000);

// Which Metro this dev-client is bound to: an agent taking the device over needs it to know whether
// the bundle on screen is the one its own branch serves, and whose isolated Metro that is.
export function recordMetro(p: Platform, port: string): void {
  const iso = metroIsIsolated() ? owner() : '';
  mstateSet(p, 'metro', `localhost:${port}`);
  if (mstateGet(p, 'metro_isolated') !== iso) mstateSet(p, 'metro_isolated', iso);
}

// A bare language becomes a locale: the region is the language's own where the two share a code
// (fr-FR, de-DE), and the usual one where they do not (en-US, not en-EN). A project whose languages
// are not plain two-letter codes gives the full tag in VYSU_LANGS. « fr » is fr-FR to Android and
// fr_FR to iOS.
export function androidLocaleOf(lang: string): string {
  if (lang.includes('-')) return lang;
  const usual: Record<string, string> = { en: 'en-US', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', sv: 'sv-SE', da: 'da-DK', cs: 'cs-CZ', el: 'el-GR', uk: 'uk-UA' };
  return usual[lang] ?? `${lang}-${lang.toUpperCase()}`;
}
export const iosLocaleOf = (lang: string): string => androidLocaleOf(lang).replaceAll('-', '_');

// The dev-client, started straight into this owner's Metro: the launcher never shows, so nothing has
// to be handed to it afterwards. iOS reads `--initialUrl <url>` from its launch arguments
// (expo-dev-launcher's initialUrlFromProcessInfo), which also spares the « Open in … ? » confirmation
// iOS 18 puts in front of a custom-scheme URL sent by simctl. Android takes the dev-client deep link as
// a VIEW intent, the one way in: its launcher never reloads the last app by itself (a plain launch sat
// on it for the ten seconds the old relaunch waited before handing the URL over).
export async function handBundle(p: Platform, lang = ''): Promise<void> {
  trace(`hand bundle ${p}`);
  launchState.handedAt = nowS();
  const bundle = config().get('MOBILE_BUNDLE');
  const port = metroPort();
  const url = metroUrl(port);
  if (p === 'android') {
    await adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
    const enc = url.replaceAll(':', '%3A').replaceAll('/', '%2F');
    await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `${config().get('MOBILE_SCHEME')}://expo-development-client/?url=${enc}`, bundle]);
  } else {
    await sim('terminate', [bundle]);
    if (lang) await sim('launch', [bundle, '--initialUrl', url, '-AppleLanguages', `(${lang})`, '-AppleLocale', iosLocaleOf(lang)]);
    else await sim('launch', [bundle, '--initialUrl', url]);
  }
  recordMetro(p, port);
  trace(`handed ${p}`);
}

// Start the app. In expo mode with a dev-client scheme, straight into this owner's Metro. Otherwise
// Android goes through the launcher intent (`am start` needs the activity name, which only the app
// knows); iOS takes the language per launch, which is why `--lang` is its own pair of arguments here
// and a system setting on the other platform.
export async function mobileLaunch(p: Platform, bundle: string, lang = ''): Promise<void> {
  if (mobileKind() === 'expo' && config().get('MOBILE_SCHEME')) return handBundle(p, lang);
  if (p === 'android') {
    // Metro is reachable as localhost from the emulator: an expo concern, and adbd restarts drop it.
    if (mobileKind() === 'expo') {
      const port = metroPort();
      await adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
    }
    await adb(['shell', 'monkey', '-p', bundle, '-c', 'android.intent.category.LAUNCHER', '1']);
  } else if (lang) {
    await sim('launch', [bundle, '-AppleLanguages', `(${lang})`, '-AppleLocale', iosLocaleOf(lang)]);
  } else {
    await sim('launch', [bundle]);
  }
}

export async function snapshotNodes(p: Platform, o: { interactive?: boolean; forceFull?: boolean; timeoutMs?: number }): Promise<Answer> {
  return adCall(p, calls.snapshot(o));
}

export async function mobileOnLauncher(p: Platform, nodes?: ReturnType<typeof nodesOf>): Promise<boolean> {
  if (p === 'android') {
    const focus = (await adbShell(['dumpsys', 'window'])).split('\n').filter((l) => l.includes('mCurrentFocus'));
    return focus.some((l) => l.includes('DevLauncher'));
  }
  const n = nodes ?? nodesOf((await snapshotNodes('ios', { interactive: true, timeoutMs: SNAPSHOT_TIMEOUT })).data);
  return onLauncher(n);
}

// Metro says when it has handed the bundle over (« iOS Bundled … » / « Android Bundled … »): cheaper
// and surer than reading the tree, which a dev-client shows nothing of until then. A « Bundling
// failed » for the same platform ends the wait at once, with the error: an edit that broke the build
// (maybe another session's, on the same checkout) otherwise reads as a two-minute timeout. A launcher
// or its error page is handed the URL again from the first look, not after a guessed delay.
export async function waitBundled(p: Platform, log: string, from: number, budget: number, who: string): Promise<void> {
  const tag = metroTag(p);
  const t0 = nowS();
  const re = new RegExp(`(^|[^A-Za-z])${tag} (Bundled|Bundling failed) [0-9]`);
  let looked = 0;
  let handed = 0;
  for (;;) {
    let last = '';
    for (const l of linesAfter(log, from).split('\n')) if (re.test(l)) last = l;
    trace(`bundled? ${last || '(nothing yet)'}`);
    if (last.includes(`${tag} Bundled `)) {
      launchState.bundledAt = nowS();
      recordMetro(p, metroPort());
      return;
    }
    if (last.includes(`${tag} Bundling failed `)) {
      const err = bundleErrorSince(from, log);
      die(`${who}: Metro could not bundle for ${tag}: ${err || `see ${log}`}`, `fix it (the edit may be another session's on the same checkout), then vysu mrelaunch ${p}`);
    }
    if (!(nowS() - t0 < budget)) die(`${who}: Metro never served the ${tag} bundle in ${budget}s (see ${log})`);
    // Every few seconds, not on every turn: a look costs a snapshot on iOS. And not in the first 20 s
    // after a hand-off: the Android launcher holds the focus for as long as it fetches the manifest,
    // and on a loaded Mac that is many seconds of a load going well, which a new hand-off would
    // restart. Twice at most, then the budget decides.
    if (config().get('MOBILE_SCHEME') && handed < 2 && nowS() - launchState.handedAt >= 20 && nowS() - looked >= 5) {
      looked = nowS();
      trace('launcher?');
      if ((p === 'android' || (await sessionOpen('ios'))) && (await mobileOnLauncher(p))) {
        await handBundle(p, launchState.lang);
        handed++;
      }
    }
    await sleep(500);
  }
}

// A dev-client sitting on Expo's launcher (a fresh install, a load that timed out) is handed this
// owner's Metro URL, then waited for: the bundle served, the first screen up. A no-op anywhere else.
// The primitive a connector calls right after its own `open`.
export async function mobileLoadBundle(p: Platform): Promise<void> {
  if (!config().get('MOBILE_SCHEME')) return;
  // A bash connector calls this as `vysu __prim`, a process of its own that has addressed no
  // emulator yet: every adb call below would go to « the » device, or fail once two are attached.
  if (p === 'android') await androidSelect();
  if (!(await mobileOnLauncher(p))) return;
  const log = metroLog();
  const from = metroLines(log);
  await handBundle(p);
  await waitBundled(p, log, from, 120, `vysu: ${p}`);
  await waitReady(p, 40);
}

// The screens that prove the app has booted come from the project (VYSU_MOBILE_READY_TEXT). On the way
// there, what stands between a launch and the app is cleared from the first look: Expo's dev menu and
// its first-run intro, pressed away by VYSU_MOBILE_DISMISS_LABELS only while the menu's own texts are
// on screen (an app button that happens to say « Close » is never pressed), and the launcher, handed
// the URL again. The session the snapshots need is reopened when it is gone or bound elsewhere.
// 0 ready, 1 not within the budget, 2 a red box.
export async function waitReady(p: Platform, budget: number): Promise<0 | 1 | 2> {
  launchState.notReady = `ready text not seen (vysu ${p} snapshot -i)`;
  const ready = commaList(config().get('MOBILE_READY_TEXT'));
  // Without them, a fixed delay is all there is.
  if (!ready.length) {
    await sleep(5000);
    return 0;
  }
  if (!(await sessionEnsure(p))) {
    launchState.notReady = `screen not checked, no agent-device session (vysu ${p} open …)`;
    return 1;
  }
  const t0 = nowS();
  let dismissed = 0;
  let handed = 0;
  let repaired = false;
  while (nowS() - t0 < budget) {
    // The whole tree, not -i: the dev menu's texts are no controls, and Android's -i leaves them out.
    // --force-full: a repeated unchanged Android snapshot otherwise answers with a bare « unchanged ».
    const a = await snapshotNodes(p, { forceFull: true, timeoutMs: SNAPSHOT_TIMEOUT });
    if (!a.ok) {
      const t = errorText(a);
      if (/SESSION_NOT_FOUND|is already bound to|DEVICE_IN_USE/.test(t)) {
        if (repaired) return 1;
        repaired = true;
        if (!(await sessionRepair(p, t))) return 1;
        continue;
      }
    }
    const nodes = nodesOf(a.data);
    trace(`ready? ${a.ok ? `${nodes.length} nodes` : errorText(a)}`);
    if (dismissed < 3 && onDevMenu(nodes)) {
      dismissed++;
      // The intro has a button; the Android menu behind it is a bottom sheet with none, which the
      // back key closes (on iOS the menu has its close button, one of the labels).
      if (!(await mobPressAny(p, config().get('MOBILE_DISMISS_LABELS', 'Continue,Close'))) && p === 'android') {
        await adCall(p, calls.back({}));
      }
      continue;
    }
    if (redbox(nodes)) {
      launchState.notReady = `red box: ${redboxMessage(nodes)}`;
      return 2;
    }
    if (ready.some((t) => hasExact(nodes, t))) return 0;
    // A process that died on the way (a native crash under memory pressure was seen) leaves the home
    // screen up, and the budget would be spent waiting for an app that is not there. One `pidof`.
    if (p === 'android' && !(await adbShell(['pidof', config().get('MOBILE_BUNDLE')])).trim()) {
      launchState.notReady = 'the app is not running, it crashed or was closed (adb logcat -b crash)';
      return 1;
    }
    if (handed < 2 && config().get('MOBILE_SCHEME') && nowS() - launchState.handedAt >= 20 && (await mobileOnLauncher(p, nodes))) {
      trace(`on the launcher: ${nodes.map((n) => n.label ?? '').filter(Boolean).slice(0, 30).join(' | ')}`);
      handed++;
      const log = metroLog();
      const from = metroLines(log);
      await handBundle(p, launchState.lang);
      await waitBundled(p, log, from, 90, `vysu: ${p}`);
      continue;
    }
    await sleep(1000);
  }
  return 1;
}

// --- pressing what a dialog shows ----------------------------------------------------------------

// By accessible name first, by visible text otherwise (a dev-menu button carries no role).
export async function mobPressIf(p: Platform, label: string): Promise<boolean> {
  if ((await adCall(p, calls.press(`role="button" label="${label}"`, { settle: true }))).ok) return true;
  return (await adCall(p, calls.press(`text="${label}"`, { settle: true }))).ok;
}
// A label a system dialog shows in the simulator's own locale: a connector names the ones it knows,
// the engine tries each in turn and never fails on a dialog that did not show up.
export async function mobPressAny(p: Platform, labels: string): Promise<boolean> {
  for (const l of labels.split(',')) {
    if (l && (await mobPressIf(p, l))) return true;
  }
  return false;
}
// The same, for a list whose labels are not alternatives but a sequence: each one is pressed if it is
// there. « Enter directly » then « Back home » are two dialogs in a row, not two names for one.
export async function mobPressAll(p: Platform, labels: string): Promise<boolean> {
  let pressed = false;
  for (const l of labels.split(',')) {
    if (l && (await mobPressIf(p, l))) pressed = true;
  }
  return pressed;
}

// --- mrelaunch -----------------------------------------------------------------------------------

export const MRELAUNCH_USAGE = 'usage: vysu mrelaunch ios|android [--textsize normal|large|xl] [--appearance light|dark] [--lang <l>]';

// Kill and relaunch the app, then wait for the bundle: a fast refresh after files moved or a provider
// changed leaves ghosts (stale contexts, cold caches) that a screenshot cannot tell from a bug:
// behaviour is judged on a clean launch. Text size and appearance are applied in between, since both
// take effect on launch. No fixed sleep on the way: every wait is a condition with a bound.
export async function mrelaunch(p: Platform, args: string[]): Promise<void> {
  let size = '';
  let mode = '';
  let lang = '';
  for (let i = 0; i < args.length; i += 2) {
    const v = args[i + 1] ?? '';
    switch (args[i]) {
      case '--textsize':
        size = v;
        break;
      case '--appearance':
        mode = v;
        break;
      case '--lang':
        lang = v;
        break;
      default:
        die(`vysu mrelaunch: unknown option ${args[i]}`);
    }
  }
  langCheck(lang);
  const bundle = config().need('MOBILE_BUNDLE', 'the app id on both platforms');
  const kind = mobileKind();
  const start = nowS();
  launchState.bundledAt = 0;
  if (p === 'android') await androidSelect();
  else await iosLock();
  if (kind === 'expo') await metroNeed('vysu mrelaunch', p);
  if (p === 'android') await adb(['shell', 'am', 'force-stop', bundle]);
  else await sim('terminate', [bundle]);
  if (size) await quiet(() => textsize(p, size));
  if (mode) await quiet(() => appearance(p, mode));
  // The app reads the OS locale at launch (expo-localization). iOS takes it per launch; Android has to
  // be told system-wide, which costs a zygote restart, so it is only done when it differs.
  if (lang && p === 'android') {
    const locale = androidLocaleOf(lang);
    if ((await adbShell(['getprop', 'persist.sys.locale'])).trim() !== locale) {
      if ((await adb(['root'])).code === 0) await adb(['shell', `setprop persist.sys.locale ${locale}; setprop ctl.restart zygote`]);
      await sleep(20000);
      await waitAndroidBoot();
      await waitAndroidShell();
      // `adb root` restarts adbd, which takes the native app-log tail down with it: without this the
      // log freezes at the last line before the language change and `vysu mlog` answers « nothing
      // since the mark » for the rest of the session. A no-op when the tail is still alive.
      if (kind === 'native') await quiet(() => applogStart(p));
    }
  }
  if (lang) mstateSet(p, 'lang', lang);
  launchState.lang = lang;
  if (kind === 'expo') {
    await quietDevMenu(p, bundle);
    const log = metroLog();
    const from = metroLines(log);
    await mobileLaunch(p, bundle, lang);
    await waitBundled(p, log, from, 180, 'vysu mrelaunch');
    // This device's own JS console, for `vysu mlog <platform> --device`: started once, it follows the
    // app through every later relaunch.
    try {
      await quiet(() => applogStart(p, 'js'), { err: true });
    } catch {
      // a console that cannot be tailed is no reason to fail the relaunch
    }
  } else {
    // Native: nothing sits between the launch and the first frame, so there is nothing to wait for
    // but the app itself: VYSU_MOBILE_READY_TEXT below, or the fixed delay when it names nothing.
    await mobileLaunch(p, bundle, lang);
  }
  let note = '';
  if ((await waitReady(p, 60)) !== 0) note = `, ${launchState.notReady}`;
  const split = launchState.bundledAt ? ` (bundled after ${launchState.bundledAt - start}s)` : '';
  say(`${p}: relaunched in ${nowS() - start}s${split}${size ? ` (text size ${size})` : ''}${mode ? ` (${mode})` : ''}${lang ? ` (${lang})` : ''}${note}`);
}
