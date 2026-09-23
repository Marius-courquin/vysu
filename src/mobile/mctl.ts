// The device conditions an agent used to reach past vysu for: a deep link opened in the running app
// (`mopen`), the network cut and brought back (`mnet`), a permission granted, denied or put back to
// « ask » (`mperm`), and a burst of 1x frames around one step (`mburst`). Each is the raw `xcrun
// simctl` / `adb` call, made under vysu's device lock, read back before it claims anything, and
// answered in one line. They answer false with one line on stderr instead of dying: a flow step calls
// them, and a link that did not land is a failed step, not the end of the flow.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { devices, iosLock, type Platform } from '../core/hold.ts';
import { metaWrite, repoSha } from '../core/meta.ts';
import { run, runBuffer } from '../core/proc.ts';
import { now } from '../core/rec.ts';
import { sleep } from '../core/text.ts';
import { marks } from '../core/ui.ts';
import { tool } from '../img/tools.ts';
import { adCall, calls } from './agent.ts';
import { buildBplist, parseBplist, readPlistFile, Uid, type PDict, type PValue } from './bplist.ts';
import { adb, adbShell, androidSdkLevel, androidSelect, iosUdid, mobileScale, sim } from './device.ts';
import { lines, quiet, say, tell, why } from './io.ts';
import { mobileKind, mobileLoadBundle, mobPressAny, mrelaunch } from './launch.ts';
import { mscreenLine } from './screen.ts';
import { nodesOf, alertStarting, onLauncher, signature } from './snap.ts';
import { mstateGet, mstateSet } from './state.ts';
import { mobileStep } from './steps.ts';
import { adbPath, crlf, xcrun } from './tools.ts';

// One line on stderr, in die's colours.
const mctlWhy = (text: string): false => {
  tell(`${marks.errOn}vysu: ${text}${marks.errOff}`);
  return false;
};
const isPlatform = (p: string): p is Platform => p === 'ios' || p === 'android';
const isInt = (s: string | undefined): boolean => !!s && /^[0-9]+$/.test(s);
const isNum = (s: string | undefined): boolean => !!s && s !== '.' && /^[0-9.]+$/.test(s) && !/\..*\./.test(s);

// Is the app's process alive? iOS: launchd names an app « UIKitApplication:<id>[…] » and lists it with
// a pid while it runs, « - » once it has exited. A permission change on either platform ends it.
async function appRunning(p: Platform, bundle: string): Promise<boolean> {
  if (p === 'android') return (await adbShell(['pidof', bundle])).trim() !== '';
  await iosLock();
  const list = (await xcrun(['simctl', 'spawn', await iosUdid(), 'launchctl', 'list'])).stdout;
  return list.split('\n').some((l) => {
    const f = l.trim().split(/\s+/);
    return /^[0-9]+$/.test(f[0] ?? '') && (f[2] ?? '').startsWith(`UIKitApplication:${bundle}[`);
  });
}

// --- mopen ---------------------------------------------------------------------------------------

const snapNodes = async (p: Platform): Promise<ReturnType<typeof nodesOf>> => nodesOf((await adCall(p, calls.snapshot({ interactive: true }))).data);

// Up = running AND past Expo's launcher. A cold deep link is the one that goes wrong: a dev-client not
// yet handed its bundle opens on the launcher and keeps the link there (seen on both platforms with the
// real app: a raw cold `am start -d` / `simctl openurl` parks it on « Development Build » for good), and
// a second link lands there too. Android answers in one `dumpsys window` (the launcher and its error
// page are both DevLauncher* activities); iOS needs a snapshot, the price of not handing a link to the
// launcher. The error page (« There was a problem loading the project »: a bundle request that timed
// out) is just as deaf to a link.
async function appUp(p: Platform, bundle: string): Promise<boolean> {
  if (!(await appRunning(p, bundle))) return false;
  if (mobileKind() !== 'expo') return true;
  if (p === 'android') {
    const focus = (await adbShell(['dumpsys', 'window'])).split('\n').find((l) => l.includes('mCurrentFocus')) ?? '';
    return !focus.includes('DevLauncher');
  }
  return !onLauncher(await snapNodes('ios'));
}

// A route is appended to VYSU_MOBILE_DEEPLINK (« myapp:/// » + « discussions/42 »); anything holding
// « :// » is already a URL and goes as it is (an https universal link included).
function mopenUrl(target: string): string | null {
  if (target.includes('://')) return target;
  const prefix = config().get('MOBILE_DEEPLINK');
  if (!prefix) {
    mctlWhy(`mopen: « ${target} » is a route and VYSU_MOBILE_DEEPLINK is not set (the prefix a route is appended to, e.g. myapp:///), or pass a full url`);
    return null;
  }
  return prefix + target.replace(/^\/+/, '');
}

// iOS 18 asks « Ouvrir dans « App » ? » before handing a custom-scheme URL from simctl to the app, the
// way Safari would; the iOS 26 simulator opens it straight away. So the alert is looked for, not
// assumed: by its own text on an [alert] node (an app button that merely says « Ouvrir » must never be
// pressed for it), twice over half a second, and pressed only if it is there.
async function confirmIos(): Promise<void> {
  for (let i = 1; i <= 2; i++) {
    if (alertStarting(await snapNodes('ios'), ['Ouvrir dans', 'Open in']) && (await mobPressAny('ios', 'Ouvrir,Open'))) return;
    if (i !== 2) await sleep(400);
  }
}

// What is on screen, reduced to one string: the tree before the link against the tree after it.
const mopenSig = async (p: Platform): Promise<string> => signature(await snapNodes(p));

// The device's shell reads the URL: a « ? » or a « & » would otherwise be read there.
export const shQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

export const MOPEN_USAGE = 'vysu mopen ios|android <route|url> [--wait "<text>"] [--timeout <s>]';

export async function mopen(p: string, args: string[]): Promise<boolean> {
  const target = args[0] ?? '';
  if (!isPlatform(p)) return mctlWhy(`usage: ${MOPEN_USAGE}`);
  if (!target) return mctlWhy(`usage: ${MOPEN_USAGE}`);
  let waitText = '';
  let timeout = 10;
  for (let i = 1; i < args.length; i += 2) {
    const v = args[i + 1];
    if (args[i] === '--wait') {
      if (!v) return mctlWhy('mopen: --wait needs a text');
      waitText = v;
    } else if (args[i] === '--timeout') {
      if (!isInt(v)) return mctlWhy('mopen: --timeout is whole seconds');
      timeout = Number(v);
    } else return mctlWhy(`mopen: unknown option ${args[i]} (usage: ${MOPEN_USAGE})`);
  }
  const url = mopenUrl(target);
  if (url === null) return false;
  const bundle = config().get('MOBILE_BUNDLE');
  if (!bundle) return mctlWhy('mopen: VYSU_MOBILE_BUNDLE is not set (the app id on both platforms)');
  if (p === 'android') await androidSelect();
  if (!(await appUp(p, bundle))) {
    why(`${p}: ${bundle} is not up (not running, or on the launcher): launching it first, so the link reaches the app`);
    await quiet(() => mrelaunch(p, []));
    // A relaunch can still come up on the launcher (seen after a raw cold link had parked the
    // dev-client there), and the link must not be handed to it: the bundle URL first, in expo mode.
    if (mobileKind() === 'expo') await mobileLoadBundle(p);
  }
  // The screen before the link, when there is no text to wait for: `am start` and `openurl` return as
  // soon as the intent is delivered, and the app routes it a second or two later (2.2 s measured on an
  // API 30 emulator, a sheet closing first). A « stable » wait alone reads the old screen, and so does a
  // change test against a screen still loading (a discussion painting its comments): the screen is let
  // settle first. `--wait` is the quick and sure way; this is the fallback.
  let before = '';
  let unchanged = false;
  if (!waitText) {
    await adCall(p, calls.waitStable(400, 4000));
    before = await mopenSig(p);
  }
  if (p === 'ios') {
    if ((await sim('openurl', [url])).code !== 0) return mctlWhy(`ios: simctl refused ${url} (no app claims that scheme?)`);
    await confirmIos();
  } else {
    // To the package, so no chooser and no browser picks it up. `am start` always adds NEW_TASK, and
    // with the singleTask activity an Expo app declares, that brings the existing task forward and
    // hands the link to it (onNewIntent) instead of stacking a second copy of the app.
    const r = await adb(['shell', `am start -a android.intent.action.VIEW -d ${shQuote(url)} ${bundle}`]);
    const out = crlf(`${r.stdout}${r.stderr}`);
    if (/Error|Exception/.test(out)) return mctlWhy(`android: ${out.split('\n').find((l) => /Error|Exception/.test(l)) ?? ''}`);
  }
  if (waitText) {
    if (!(await adCall(p, calls.waitText(waitText, timeout * 1000))).ok) {
      return mctlWhy(`${p}: opened ${url} but « ${waitText} » did not show within ${timeout}s · ${await mscreenLine(p)}`);
    }
  } else {
    // No text to wait for: until the tree differs from the one before the link (5 s at most: a link to
    // the screen already shown changes nothing), then until it holds still for half a second (the push
    // animation, the first query landing), bounded so a screen that never settles costs 5 s.
    const until = Number(now()) + 5;
    while ((await mopenSig(p)) === before) {
      if (!(Number(now()) < until)) {
        unchanged = true;
        break;
      }
      await sleep(200);
    }
    if (!unchanged) await adCall(p, calls.waitStable(500, 5000));
  }
  // A tree that never moved is said, not hidden behind the old labels: the link may have gone nowhere,
  // or opened what the tree does not show (an iOS pageSheet, seen with the real app).
  const note = unchanged ? ' · the tree did not change in 5s (same screen, or a sheet it does not show: --wait "<text>")' : '';
  say(`${p}: opened ${url} · ${await mscreenLine(p)}${note}`);
  return true;
}

// --- mnet ----------------------------------------------------------------------------------------

// The emulator's radios, through airplane mode: the one switch that cuts Wi-Fi and cellular for the
// whole device and that the app sees exactly as a user's. `adb reverse` rides the adb channel, not the
// network, so Metro keeps serving the bundle while the app's own requests fail.
const airplane = async (): Promise<string> => (await adbShell(['settings', 'get', 'global', 'airplane_mode_on'])).replace(/\n+$/, '');
async function defaultNetwork(): Promise<string> {
  const line = (await adbShell(['dumpsys', 'connectivity'])).split('\n').find((l) => l.includes('Active default network')) ?? '';
  const at = line.lastIndexOf(': ');
  return (at >= 0 ? line.slice(at + 2) : line) || 'none';
}

export const MNET_USAGE = 'vysu mnet ios|android offline|online';

export async function mnet(p: string, args: string[]): Promise<boolean> {
  const want = args[0] ?? '';
  if (!isPlatform(p)) return mctlWhy(`usage: ${MNET_USAGE}`);
  if (want !== 'offline' && want !== 'online') return mctlWhy(`usage: ${MNET_USAGE}`);
  if (p === 'ios') {
    // Nothing vysu could do here would be honest: simctl has no network verb, and a simulator uses the
    // Mac's own stack, so the only switch is host-wide, and cutting the Mac is not vysu's call.
    return mctlWhy(
      "ios: a simulator has no network switch of its own (it shares the Mac's stack, and simctl has none): check offline on Android (vysu mnet android offline), or turn the Mac's Wi-Fi off yourself, which cuts everything on it (Metro on localhost keeps serving)",
    );
  }
  await androidSelect();
  const on = want === 'offline' ? '1' : '0';
  // `cmd connectivity airplane-mode` exists from API 30 and broadcasts the change itself. Below it, the
  // setting plus the broadcast the Settings app sends; recent images refuse that broadcast to the
  // shell, which is why the setting is read back rather than trusted.
  await adbShell(['cmd', 'connectivity', 'airplane-mode', on === '1' ? 'enable' : 'disable']);
  if ((await airplane()) !== on) {
    await adbShell(['settings', 'put', 'global', 'airplane_mode_on', on]);
    await adbShell(['am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', on === '1' ? 'true' : 'false']);
  }
  const reads = await airplane();
  if (reads !== on) return mctlWhy(`android: airplane_mode_on still reads ${reads} (wanted ${on}): this image refused both ways of switching it`);
  // The radios follow the setting a beat later, and coming back takes a DHCP round: the answer is given
  // once the network the app would use is gone, or is back, so the next step sees that state.
  let net = await defaultNetwork();
  for (let i = 0; i < 40; i++) {
    if (on === '1' ? net === 'none' : net !== 'none') break;
    await sleep(500);
    net = await defaultNetwork();
  }
  if (on === '1') {
    mstateSet('android', 'net', 'offline');
    if (net !== 'none') return mctlWhy(`android: airplane mode on, but network ${net} is still the default after 20s`);
    say('android: offline (airplane mode on · no default network)');
  } else {
    mstateSet('android', 'net', '');
    if (net === 'none') return mctlWhy("android: airplane mode off, but no default network after 20s (the emulator's Wi-Fi may need a moment more)");
    say(`android: online (airplane mode off · default network ${net})`);
  }
  return true;
}

// --- mperm ---------------------------------------------------------------------------------------

// One vocabulary for both platforms: the seven names a test asks for, each mapped to what the platform
// calls it. Anything else is passed through as the platform's own name.
const MPERM_NAMES = 'notifications camera photos location microphone contacts calendar';
export function androidPermission(name: string, sdk: number): string {
  switch (name) {
    case 'notifications':
      return 'android.permission.POST_NOTIFICATIONS';
    case 'camera':
      return 'android.permission.CAMERA';
    // Photos split from storage in API 33: READ_MEDIA_IMAGES there, READ_EXTERNAL_STORAGE before.
    case 'photos':
      return sdk >= 33 ? 'android.permission.READ_MEDIA_IMAGES' : 'android.permission.READ_EXTERNAL_STORAGE';
    case 'location':
      return 'android.permission.ACCESS_FINE_LOCATION';
    case 'microphone':
      return 'android.permission.RECORD_AUDIO';
    case 'contacts':
      return 'android.permission.READ_CONTACTS';
    case 'calendar':
      return 'android.permission.READ_CALENDAR';
    default:
      return name.includes('.') ? name : `android.permission.${name}`;
  }
}

// The runtime line of that permission in `dumpsys package`, as « granted=… flags … »: only the flags
// that decide what the app sees next (user-set = refused once, the app may ask again; user-fixed =
// « don't ask again », the system answers for the user). '' when the app does not request it.
export function androidPermissionState(dump: string, perm: string): string {
  const line = dump.split('\n').find((l) => l.includes(`${perm}: granted=`));
  if (!line) return '';
  const granted = /granted=([a-z]*)/.exec(line)?.[1] ?? '';
  const flagsRaw = /flags=\[(.*)\]/.exec(line)?.[1] ?? '';
  const flags = flagsRaw
    .split('|')
    .map((f) => f.replace(/ /g, ''))
    .filter((f) => /^(USER_SET|USER_FIXED|POLICY_FIXED|SYSTEM_FIXED|GRANTED_BY_DEFAULT|ONE_TIME)$/.test(f))
    .join('|');
  return `granted=${granted}${flags ? ` ${flags}` : ''}`;
}
const permState = async (bundle: string, perm: string): Promise<string> => androidPermissionState(await adbShell(['dumpsys', 'package', bundle]), perm);

// The line of a `pm` failure worth reading: the exception's own message, not « Exception occurred ».
// A class name has capitals (java.lang.SecurityException): a lower-case pattern never matches one,
// and would print « Exception occurred while executing » instead.
export function pmError(out: string): string {
  const ls = crlf(out).split('\n');
  const line = ls.find((l) => /^[A-Za-z.]+(Exception|Error): /.test(l)) ?? ls.find((l) => l !== '') ?? '';
  const at = line.indexOf(': ');
  return at >= 0 ? line.slice(at + 2) : line;
}
const permWord = (a: string): string => ({ grant: 'granted', deny: 'denied', reset: 'reset' })[a] ?? a;
const permNext = (a: string): string => (a === 'reset' ? ' · the app will ask again' : '');

async function mpermAndroid(name: string, action: string): Promise<boolean> {
  await androidSelect();
  const bundle = config().get('MOBILE_BUNDLE');
  const sdk = await androidSdkLevel();
  if (name === 'notifications' && sdk < 33) {
    // Before API 33 there is no runtime permission: notifications are on from the install, and only
    // the user's toggle in the system settings turns them off. There is no prompt to reset.
    if (action === 'grant') {
      say(`android: notifications need no permission below API 33 (this image is API ${sdk}): already allowed`);
      return true;
    }
    return mctlWhy(
      `android: API ${sdk} has no notification permission (POST_NOTIFICATIONS is API 33+): the app never asks, and only the system settings toggle turns them off; nothing to ${action} here`,
    );
  }
  const perm = androidPermission(name, sdk);
  const before = await permState(bundle, perm);
  if (!before) return mctlWhy(`android: ${bundle} does not request ${perm} (not in its manifest, or not a runtime permission on API ${sdk}): nothing to ${action}`);
  const wasRunning = (await adbShell(['pidof', bundle])).trim() !== '';
  let rc = 0;
  let noflags = false;
  let note = '';
  let out = '';
  const pm = async (args: string[]): Promise<void> => {
    const r = await adb(['shell', 'pm', ...args]);
    out = `${r.stdout}${r.stderr}`;
    rc = r.code;
  };
  // `pm set-permission-flags` / `clear-permission-flags` exist from API 31: API 30 lists them in its
  // help and answers « Unknown command ». There, noflags says so and the caller decides what that
  // costs; any other failure is the caller's error line.
  const flagsCall = async (verb: 'set' | 'clear'): Promise<void> => {
    const r = await adb(['shell', 'pm', `${verb}-permission-flags`, bundle, perm, 'user-set', 'user-fixed']);
    const o = crlf(`${r.stdout}${r.stderr}`);
    if (o.startsWith('Unknown command')) {
      noflags = true;
      out = '';
      return;
    }
    out = o;
    if (/Exception|Error/.test(o)) rc = 1;
  };
  if (action === 'grant') await pm(['grant', bundle, perm]);
  // Denied the way a user leaves it after a second « Don't allow »: revoked and fixed, so the app reads
  // a refusal and the system shows no prompt. A single refusal is what `reset` + one « no » gives.
  else if (action === 'deny') {
    await pm(['revoke', bundle, perm]);
    if (rc === 0) await flagsCall('set');
  }
  // Back to « never asked »: revoked, and the two flags a refusal leaves cleared, so the app's next
  // request shows the system prompt again.
  else {
    await pm(['revoke', bundle, perm]);
    if (rc === 0) await flagsCall('clear');
  }
  // `pm` answers « Exception occurred… » with a stack trace, sometimes on a zero exit.
  if (/Exception|Error/.test(out)) rc = 1;
  if (rc !== 0) return mctlWhy(`android: pm ${action} ${perm}: ${pmError(out)}`);
  const after = await permState(bundle, perm);
  let ok = true;
  if (action === 'grant') ok = after.startsWith('granted=true');
  else if (action === 'deny') {
    if (after.startsWith('granted=false') && after.includes('USER_FIXED')) ok = true;
    else if (after.startsWith('granted=false')) {
      if (!noflags) ok = false;
      note = ` · API ${sdk}: pm cannot set « don't ask again » (API 31+), so the app may ask once more`;
    } else ok = false;
  } else if (after === 'granted=false') ok = true;
  else if (after.startsWith('granted=false ')) ok = !/USER_SET|USER_FIXED/.test(after);
  else ok = false;
  if (!ok && noflags && action === 'reset') {
    return mctlWhy(
      `android: ${perm} is revoked, but the user's earlier refusal stays (${after}): pm cannot clear it before API 31 (this image is API ${sdk}), so the prompt will not come back (only a reinstall, or pm reset-permissions for every app at once, clears it)`,
    );
  }
  if (!ok) return mctlWhy(`android: ${name} ${action} did not hold: ${perm} reads ${after} (was ${before})`);
  // Android kills an app whose permission is taken away; the next step has to know it relaunches.
  const stopped = wasRunning && (await adbShell(['pidof', bundle])).trim() === '' ? ' · the app was stopped (a revoke kills it)' : '';
  say(`android: ${name} ${permWord(action)} · ${perm} ${after} (was ${before})${permNext(action)}${stopped}${note}`);
  return true;
}

// iOS: `simctl privacy` speaks TCC for the services it lists; the answer is read back from the
// simulator's own TCC.db, where each one has its row. Location is locationd's, not TCC's: its
// clients.plist holds « Authorization » per app (1 denied, 2 when in use, 4 always, absent = never
// asked). The camera has no simctl service at all (and a simulator no camera).
const TCC: Record<string, string> = {
  photos: 'kTCCServicePhotos',
  'photos-add': 'kTCCServicePhotosAdd',
  microphone: 'kTCCServiceMicrophone',
  contacts: 'kTCCServiceAddressBook',
  'contacts-limited': 'kTCCServiceAddressBook',
  calendar: 'kTCCServiceCalendar',
  reminders: 'kTCCServiceReminders',
  'media-library': 'kTCCServiceMediaLibrary',
  motion: 'kTCCServiceMotion',
  siri: 'kTCCServiceSiri',
};
const simData = async (): Promise<string> => join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', await iosUdid(), 'data');

// Read-only: tccd owns the file (in WAL mode), a reader never has to write to it. node:sqlite where
// the runtime has it, the system's sqlite3 elsewhere (every Mac has one).
async function tccValue(db: string, service: string, client: string): Promise<string> {
  try {
    const m = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string, o: object) => { prepare(q: string): { get(...a: string[]): unknown }; close(): void } };
    const d = new m.DatabaseSync(db, { readOnly: true });
    try {
      const row = d.prepare('select auth_value from access where service = ? and client = ? limit 1').get(service, client) as { auth_value?: number } | undefined;
      return row?.auth_value === undefined ? '' : String(row.auth_value);
    } finally {
      d.close();
    }
  } catch {
    const q = `select auth_value from access where service = '${service.replaceAll("'", "''")}' and client = '${client.replaceAll("'", "''")}' limit 1`;
    const r = await run('sqlite3', ['-readonly', db, q]);
    return r.code === 0 ? r.stdout.trim() : '';
  }
}
async function iosTccState(service: string, bundle: string): Promise<string> {
  const db = join(await simData(), 'Library', 'TCC', 'TCC.db');
  if (!existsSync(db)) return 'unknown';
  const v = await tccValue(db, service, bundle);
  return ({ '0': 'denied', '2': 'granted', '3': 'limited', '': 'not asked' } as Record<string, string>)[v] ?? `auth_value ${v}`;
}
async function iosLocationState(bundle: string): Promise<string> {
  const f = join(await simData(), 'Library', 'Caches', 'locationd', 'clients.plist');
  if (!existsSync(f)) return 'not asked';
  let a: PValue | undefined;
  try {
    a = ((await readPlistFile(f)) as PDict)[`i${bundle}:`] as PValue;
    a = a && typeof a === 'object' ? (a as PDict).Authorization : undefined;
  } catch {
    a = undefined;
  }
  return ({ 1: 'denied', 2: 'granted', 4: 'granted always' } as Record<string, string>)[String(a)] ?? (a === undefined || a === null ? 'not asked' : `authorization ${String(a)}`);
}
const iosRead = (tcc: string, bundle: string): Promise<string> => (tcc === 'locationd' ? iosLocationState(bundle) : iosTccState(tcc, bundle));

async function mpermIos(name: string, action: string): Promise<boolean> {
  const bundle = config().get('MOBILE_BUNDLE');
  if (name === 'notifications') return mpermIosNotifications(action);
  if (name === 'camera') return mctlWhy(`ios: simctl privacy has no camera service, and a simulator has no camera: nothing to ${action} (check camera flows on Android)`);
  const service = name;
  await iosLock();
  let tcc = TCC[service] ?? '';
  if (service === 'location' || service === 'location-always') tcc = 'locationd';
  const before = tcc ? await iosRead(tcc, bundle) : '';
  const wasRunning = await appRunning('ios', bundle);
  const verb = action === 'deny' ? 'revoke' : action;
  const r = await sim('privacy', [verb, service, bundle]);
  if (r.code !== 0) return mctlWhy(`ios: simctl privacy ${verb} ${service}: ${r.out.split('\n').find((l) => l !== '') ?? ''}`);
  const stopped = wasRunning && !(await appRunning('ios', bundle)) ? ' · the app was stopped (simctl ends it on a change)' : '';
  if (!tcc) {
    say(`ios: ${name} ${permWord(action)} · simctl privacy ${verb} ${service} (no read-back known for this service)${permNext(action)}${stopped}`);
    return true;
  }
  let want = ({ grant: 'granted', deny: 'denied', reset: 'not asked' } as Record<string, string>)[action]!;
  if (service === 'location-always' && action === 'grant') want = 'granted always';
  // locationd writes its file a beat after simctl returns; TCC.db is there at once.
  let after = '';
  for (let i = 0; i < 6; i++) {
    after = await iosRead(tcc, bundle);
    if (after === want) break;
    await sleep(300);
  }
  if (after !== want) return mctlWhy(`ios: ${name} ${action} did not hold: ${tcc} reads « ${after} » (was « ${before} »)`);
  say(`ios: ${name} ${permWord(action)} · ${tcc} ${after} (was ${before})${permNext(action)}${stopped}`);
  return true;
}

// Notifications are not TCC's: SpringBoard's BulletinBoard keeps one archived BBSectionInfo per app in
// data/Library/BulletinBoard/VersionedSectionInfo.plist, and its authorizationStatus (0 never asked, 1
// denied, 2 granted, 3 provisional) is what UNUserNotificationCenter answers the app. `simctl privacy`
// has no service for it, so that file is the one handle: `reset` drops the app's section (iOS then
// treats it as never asked, and the next request prompts), `deny` / `grant` set the status.
// SpringBoard holds the sections in memory and writes them back: it is stopped with SIGKILL right after
// the edit (a clean exit would save its own copy over it) and launchd starts it again from the file,
// along with usernotificationsd, which caches what it last read. The section vysu removed or changed is
// kept under the state folder, so a `grant` after a `reset` puts the app's own section back rather than
// one made up.
const BB_NAMES: Record<string, string> = { 0: 'not asked', 1: 'denied', 2: 'granted', 3: 'provisional', 4: 'ephemeral' };
function settingsOf(blob: Uint8Array): { archive: PDict; settings: PDict } {
  const archive = parseBplist(blob) as PDict;
  const objects = archive.$objects as PValue[];
  const root = objects[((archive.$top as PDict).root as Uid).value] as PDict;
  return { archive, settings: objects[(root.sectionInfoSettings as Uid).value] as PDict };
}
// 'read' → the status; the edits → '' done, 'none' no section to edit.
export async function bulletin(path: string, bundle: string, op: 'read' | 'reset' | 'grant' | 'deny', saved: string): Promise<string> {
  const top = (await readPlistFile(path)) as PDict;
  const sections = (top.sectionInfo ??= {}) as PDict;
  let blob = sections[bundle] as Uint8Array | undefined;
  if (op === 'read') {
    if (!blob) return 'not asked';
    const s = settingsOf(blob).settings.authorizationStatus;
    return BB_NAMES[String(s)] ?? `status ${String(s ?? 'None')}`;
  }
  if (op === 'reset') {
    if (!blob) return '';
    writeFileSync(saved, blob);
    delete sections[bundle];
  } else {
    if (!blob) {
      if (!existsSync(saved)) return 'none';
      blob = new Uint8Array(readFileSync(saved));
    } else writeFileSync(saved, blob);
    const { archive, settings } = settingsOf(blob);
    settings.authorizationStatus = op === 'grant' ? 2 : 1;
    sections[bundle] = new Uint8Array(buildBplist(archive));
  }
  writeFileSync(`${path}.vysu`, buildBplist(top));
  renameSync(`${path}.vysu`, path);
  return '';
}
async function springboardPid(udid: string): Promise<string> {
  const r = await xcrun(['simctl', 'spawn', udid, 'launchctl', 'print', 'user/foreground/com.apple.SpringBoard']);
  for (const l of r.stdout.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f[0] === 'pid') return f[2] ?? '';
  }
  return '';
}
async function mpermIosNotifications(action: string): Promise<boolean> {
  const bundle = config().get('MOBILE_BUNDLE');
  await iosLock();
  const udid = await iosUdid();
  const file = join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid, 'data', 'Library', 'BulletinBoard', 'VersionedSectionInfo.plist');
  if (!existsSync(file)) return mctlWhy(`ios: no BulletinBoard file on this simulator (${file}): nothing to ${action}`);
  mkdirSync(config().state, { recursive: true });
  const saved = join(config().state, `bulletin-${udid}-${bundle}.section`);
  let before: string;
  try {
    before = await bulletin(file, bundle, 'read', saved);
  } catch {
    return mctlWhy(`ios: cannot read ${file}`);
  }
  const oldPid = await springboardPid(udid);
  let done: string;
  try {
    done = await bulletin(file, bundle, action as 'grant', saved);
  } catch {
    return mctlWhy(`ios: could not rewrite ${file}`);
  }
  if (done === 'none') {
    return mctlWhy(`ios: ${bundle} has never asked for notifications on this simulator, so there is no section to ${action}: let the app ask once (then deny / grant / reset work)`);
  }
  await xcrun(['simctl', 'spawn', udid, 'launchctl', 'kill', 'SIGKILL', 'user/foreground/com.apple.SpringBoard']);
  await xcrun(['simctl', 'spawn', udid, 'launchctl', 'kill', 'SIGKILL', 'user/foreground/com.apple.usernotificationsd']);
  // Back when launchd has a new SpringBoard running; the home screen takes a moment more to paint.
  let pid = '';
  for (let i = 0; i < 40; i++) {
    pid = await springboardPid(udid);
    if (pid && pid !== oldPid) break;
    await sleep(500);
  }
  if (!pid || pid === oldPid) return mctlWhy(`ios: SpringBoard did not come back after the restart (pid ${pid || 'none'})`);
  await sleep(2000);
  let after = '';
  try {
    after = await bulletin(file, bundle, 'read', saved);
  } catch {
    after = '';
  }
  const want = ({ grant: 'granted', deny: 'denied', reset: 'not asked' } as Record<string, string>)[action];
  if (after !== want) return mctlWhy(`ios: notifications ${action} did not hold: SpringBoard reads « ${after} » back (was « ${before} »)`);
  say(`ios: notifications ${permWord(action)} · BulletinBoard ${after} (was ${before})${permNext(action)} · SpringBoard restarted: relaunch the app (vysu mrelaunch ios)`);
  return true;
}

export const MPERM_USAGE = `vysu mperm ios|android <permission> grant|deny|reset  (permission: ${MPERM_NAMES.replaceAll(' ', ', ')}, or the platform's own name)`;

export async function mperm(p: string, args: string[]): Promise<boolean> {
  const [name = '', action = ''] = args;
  if (!isPlatform(p)) return mctlWhy(`usage: ${MPERM_USAGE}`);
  if (!name) return mctlWhy(`usage: ${MPERM_USAGE}`);
  if (!['grant', 'deny', 'reset'].includes(action)) return mctlWhy(`usage: ${MPERM_USAGE}`);
  if (args.length > 2) return mctlWhy(`usage: ${MPERM_USAGE}`);
  // adb joins the words of `adb shell pm …` into one line for the device's shell: a name is a
  // permission's (letters, digits, _ and .), or « CAMERA;reboot » reboots the emulator.
  if (p === 'android' && !/^[A-Za-z0-9_.]+$/.test(name)) return mctlWhy(`mperm: « ${name} » is not an android permission name (letters, digits, _ and . only)`);
  if (!config().get('MOBILE_BUNDLE')) return mctlWhy('mperm: VYSU_MOBILE_BUNDLE is not set (the app id on both platforms)');
  return p === 'android' ? mpermAndroid(name, action) : mpermIos(name, action);
}

// --- mburst --------------------------------------------------------------------------------------

// A skeleton turning into content, a sheet rising, a toast: a state that lasts half a second is what a
// screenshot misses and a recording buries in 90 frames. A burst is plain screenshots, as fast as the
// platform gives them (simctl's own capture on iOS, `screencap` on Android, both far quicker than
// agent-device's), started before the step so the first frame is the screen it acts on. The burst
// helper brings them to 1x and keeps the ones that differ from the last one kept, under the diff's
// rule. The capture loop runs beside the steps in this process: it stops when told, on its own
// deadline, and with the command.
async function burstLoop(p: Platform, raw: string, every: number, target: string, maxSeconds: number, stop: { now: boolean }): Promise<void> {
  const deadline = Number(now()) + maxSeconds;
  let i = 0;
  while (!stop.now && Number(now()) < deadline) {
    const f = join(raw, `${String(i).padStart(3, '0')}.png`);
    const t0 = now();
    if (p === 'ios') await xcrun(['simctl', 'io', target, 'screenshot', f]);
    else {
      const r = await runBuffer(adbPath(), ['-s', target, 'exec-out', 'screencap', '-p']);
      writeFileSync(f, r.stdout);
    }
    const t1 = now();
    appendFileSync(join(raw, 'times.tsv'), `${i}\t${t0}\t${t1}\n`);
    i++;
    // The cadence asked for, never faster than a capture takes: what is left of the period, if any.
    const left = every - (Number(t1) - Number(t0));
    if (left > 0) await sleep(left * 1000);
  }
}

export const MBURST_USAGE = 'vysu mburst ios|android <name> [--seconds 3] [--every 0.3] [-- "<step>" …]';

export async function mburst(p: string, args: string[]): Promise<boolean> {
  const name = args[0] ?? '';
  if (!isPlatform(p)) return mctlWhy(`usage: ${MBURST_USAGE}`);
  if (!name) return mctlWhy(`usage: ${MBURST_USAGE}`);
  let seconds = '3';
  let every = '0.3';
  let steps: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--seconds') {
      if (!isNum(args[i + 1])) return mctlWhy('mburst: --seconds is a number');
      seconds = args[++i]!;
    } else if (a === '--every') {
      if (!isNum(args[i + 1])) return mctlWhy('mburst: --every is a number of seconds');
      every = args[++i]!;
    } else if (a === '--') {
      steps = args.slice(i + 1);
      break;
    } else return mctlWhy(`mburst: unknown option ${a} (usage: ${MBURST_USAGE})`);
  }
  let target: string;
  if (p === 'android') target = await androidSelect();
  else {
    await iosLock();
    target = await iosUdid();
  }
  const scale = await mobileScale(p);
  const dir = join(config().shots, name);
  const raw = join(dir, `.burst-${p}`);
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const stop = { now: false };
  // The loop's own deadline covers a step that hangs: the burst plus a minute, then it stops anyway.
  const loop = burstLoop(p, raw, Number(every), target, Number(seconds) + 60, stop);
  // A step that dies (an i18n key that does not exist, a lock given up) must end the loop too, and
  // before the locks go: 0.5.1's loop watched vysu's pid, this one lives in vysu and kept capturing a
  // device already handed to the next agent for up to a minute.
  let failed = false;
  try {
    const times = join(raw, 'times.tsv');
    const firstRow = (): string => {
      try {
        return readFileSync(times, 'utf8').split('\n')[0] ?? '';
      } catch {
        return '';
      }
    };
    for (let i = 0; i < 200 && !firstRow(); i++) await sleep(50);
    if (!firstRow()) return mctlWhy(`${p}: the first capture never came back`);
    const tFirst = Number(firstRow().split('\t')[2]);
    for (const step of steps) {
      if (!(await quiet(() => mobileStep(p, name, step)))) {
        failed = true;
        mctlWhy(`mburst: step failed: ${step}`);
      }
    }
    // The burst lasts --seconds from its first frame, or until the step is done if that is later:
    // what the step causes is the point of the burst.
    const left = tFirst + Number(seconds) - Number(now());
    if (left > 0) await sleep(left * 1000);
  } finally {
    stop.now = true;
    await loop;
  }
  const r = await tool('burst', [raw, '--out-dir', dir, '--platform', p, '--scale', scale]);
  const out = `${r.stdout}${r.stderr}`.replace(/\n+$/, '');
  if (r.code !== 0) return mctlWhy(`burst: ${lines(out).pop() ?? ''}`);
  rmSync(raw, { recursive: true, force: true });
  writeFileSync(join(dir, `${p}-burst.txt`), `${out.split('\n')[0] ?? ''}\n`);
  say(out);
  await metaWrite(dir, {
    kind: 'mobile',
    platform: p,
    device: devices.of(p),
    burst: 'true',
    textsize: mstateGet(p, 'textsize', 'normal'),
    appearance: mstateGet(p, 'appearance', 'light'),
    lang: mstateGet(p, 'lang', config().get('LANG')),
    mobile_sha: repoSha(config().mobileDir || config().projectDir),
  });
  return !failed;
}

