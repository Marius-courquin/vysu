// The app's own log in native mode, one file per platform, written by the tail `vysu up` starts. In
// expo mode, `js`: the JS console of ONE device (`vysu mlog <platform> --device`), one file per device,
// since Metro's log mixes every device that bundles from it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../core/ctx.ts';
import { devices, type Platform } from '../core/hold.ts';
import { pidAlive } from '../core/host.ts';
import { killTree, run, spawnDetached } from '../core/proc.ts';
import { slug, sleep } from '../core/text.ts';
import { adb, androidSelect, iosUdid, serial } from './device.ts';
import { say } from './io.ts';
import { adbPath, crlf, xcrun } from './tools.ts';

type Kind = '' | 'js';
const deviceSlug = (p: Platform): string => slug(devices.of(p));

export function applogFile(p: Platform, kind: Kind = ''): string {
  return kind === 'js' ? join(config().logs, `${p}-js-${deviceSlug(p)}.log`) : join(config().logs, `${p}-app.log`);
}
export function applogPidFile(p: Platform, kind: Kind = ''): string {
  return kind === 'js' ? join(config().state, `jslog-${p}-${deviceSlug(p)}.pid`) : join(config().state, `applog-${p}.pid`);
}

// The pid file holds one pid per line: the tail is a single process on iOS and on a recent Android,
// and a filter over `adb logcat` on an older one. The first line is the one whose death means the
// tail is over, and `applogStop` kills them all.
function pids(f: string): number[] {
  try {
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(Number).filter((n) => n > 0);
  } catch {
    return [];
  }
}
export function applogAlive(p: Platform, kind: Kind = ''): boolean {
  const first = pids(applogPidFile(p, kind))[0];
  return first !== undefined && pidAlive(first);
}

// `vysu mlog` with no platform: the one that was last written to, iOS when neither exists yet.
export function applogPlatform(): Platform {
  let newest: Platform | '' = '';
  let t = -1;
  for (const p of ['ios', 'android'] as const) {
    try {
      const m = statSync(applogFile(p)).mtimeMs;
      if (m > t) {
        t = m;
        newest = p;
      }
    } catch {
      // not there
    }
  }
  return newest || 'ios';
}

// The executable inside the .app: what `log stream` matches a process on. A bundle id is not a
// process name, and `processImagePath ENDSWITH "/<exe>"` is the one predicate that holds across a
// relaunch (the pid changes, the path does not) without catching a neighbour of the same prefix.
async function iosAppExecutable(bundle: string): Promise<string> {
  const r = await xcrun(['simctl', 'get_app_container', await iosUdid(), bundle, 'app']);
  const path = r.stdout.trim();
  if (r.code !== 0 || !path) return '';
  const exe = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(path, 'Info.plist')]);
  return exe.stdout.trim() || basename(path, '.app');
}

// The uid the package runs under: `logcat --uid` then follows the app through every relaunch, where
// a pid filter would stop at the first force-stop.
export async function androidAppUid(pkg: string): Promise<string> {
  const out = crlf((await adb(['shell', 'dumpsys', 'package', pkg])).stdout);
  return /(?:userId|uid)=([0-9]+)/.exec(out)?.[1] ?? '';
}

// `logcat --uid` only exists from API 31: on an API 30 image the tail dies on « Unknown option
// '--uid' » and the log holds that one line. There, `-v uid` prints the uid of every line — « (10166:
// 2291) » — and the same filter is applied here, which survives a relaunch exactly as --uid does.
async function logcatHasUid(): Promise<boolean> {
  const r = await adb(['shell', 'logcat', '--help']);
  return `${r.stdout}${r.stderr}`.includes('--uid');
}

// The filter an old image's tail goes through: a small process of its own, which ends its logcat
// when it is stopped and records that logcat's pid beside its own.
const UID_FILTER = `
const [adb, serial, uid, pidFile] = process.argv.slice(-4);
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const c = spawn(adb, ['-s', serial, 'logcat', '-v', 'time', '-v', 'uid', '-T', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
try { appendFileSync(pidFile, c.pid + '\\n'); } catch {}
const re = new RegExp('\\\\( *' + uid + ': *[0-9]+\\\\)');
let rest = '';
c.stdout.on('data', (b) => {
  const parts = (rest + b.toString('utf8')).split('\\n');
  rest = parts.pop();
  for (const l of parts) if (re.test(l)) process.stdout.write(l + '\\n');
});
const stop = () => { try { c.kill(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop);
c.on('close', () => process.exit(0));
`;

// The tail `vysu up <platform>` starts in native mode: the app's own log, from now on, into
// logs/<platform>-app.log, which `vysu mlog` then reads exactly as it reads Metro's. With `js` (expo
// mode, started by `vysu mrelaunch` and `vysu mlog <platform> --device|mark`), the JS console of this
// device only: React Native writes it to os_log under com.facebook.react.log / javascript on iOS (a
// console.log at the info level, which `log stream` hides unless asked), and to logcat under the
// ReactNativeJS tag on Android. Both filters outlive a relaunch, as the native ones do.
export async function applogStart(p: Platform, kind: Kind = ''): Promise<void> {
  const log = applogFile(p, kind);
  const pidf = applogPidFile(p, kind);
  const js = kind === 'js' ? 'JS ' : '';
  if (applogAlive(p, kind)) {
    say(`${p}: ${js}log already tailing (${log})`);
    return;
  }
  mkdirSync(config().logs, { recursive: true });
  mkdirSync(config().state, { recursive: true });
  const bundle = config().get('MOBILE_BUNDLE');
  const env = config().childEnv();
  if (kind === 'js' && p === 'android') {
    await androidSelect();
    const pid = spawnDetached(adbPath(), ['-s', serial.value, 'logcat', '-v', 'time', '-T', '1', '-s', 'ReactNativeJS:V'], { log, env });
    writeFileSync(pidf, `${pid}\n`);
    say(`${p}: JS log → ${log} (vysu mlog ${p} --device)`);
    return;
  }
  if (p === 'ios') {
    const exe = await iosAppExecutable(bundle);
    if (!exe) {
      say(`ios: ${bundle} is not installed, no ${js}log (vysu up ios --reinstall)`);
      return;
    }
    let predicate = `processImagePath ENDSWITH "/${exe}" AND eventType == "logEvent" AND messageType != debug`;
    let level: string[] = [];
    if (kind === 'js') {
      predicate = `processImagePath ENDSWITH "/${exe}" AND subsystem == "com.facebook.react.log" AND category == "javascript"`;
      level = ['--level', 'info'];
    }
    const pid = spawnDetached('xcrun', ['simctl', 'spawn', await iosUdid(), 'log', 'stream', '--style', 'compact', ...level, '--predicate', predicate], { log, env });
    writeFileSync(pidf, `${pid}\n`);
    if (kind === 'js') {
      say(`ios: JS log → ${log} (vysu mlog ios --device)`);
      return;
    }
  } else {
    await androidSelect();
    // No uid is an answer — the app is not there, or the system services are not back yet — and the
    // line below says which.
    const uid = await androidAppUid(bundle);
    if (!uid) {
      say(`android: ${bundle} is not installed — no app log (vysu up android --reinstall)`);
      return;
    }
    if (await logcatHasUid()) {
      const pid = spawnDetached(adbPath(), ['-s', serial.value, 'logcat', '-v', 'time', '-T', '1', `--uid=${uid}`], { log, env });
      writeFileSync(pidf, `${pid}\n`);
    } else {
      writeFileSync(pidf, '');
      const pid = spawnDetached(process.execPath, ['-e', UID_FILTER, adbPath(), serial.value, uid, pidf], { log, env });
      writeFileSync(pidf, `${pid}\n`);
      // The filter notes its logcat's pid a beat later, beside its own.
      await sleep(1000);
    }
  }
  say(`${p}: app log → ${log} (vysu mlog)`);
}

// What `vysu down applog` calls: the app tails and every device's JS tail.
export function applogStop(platforms: Platform[]): void {
  let stopped = false;
  const state = config().state;
  for (const p of platforms) {
    let js: string[] = [];
    try {
      js = readdirSync(state).filter((f) => f.startsWith(`jslog-${p}-`) && f.endsWith('.pid')).sort();
    } catch {
      // no state yet
    }
    for (const f of [applogPidFile(p), ...js.map((x) => join(state, x))]) {
      if (!existsSync(f) || statSync(f).size === 0) continue;
      for (const pid of pids(f)) killTree(pid);
      rmSync(f, { force: true });
      const name = basename(f);
      const what = name.startsWith('jslog-') ? `JS log of ${name.slice(`jslog-${p}-`.length, -'.pid'.length)}` : 'app log';
      say(`${p}: ${what} stopped`);
      stopped = true;
    }
  }
  if (!stopped) say('applog: nothing was tailing');
}
