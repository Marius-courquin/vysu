// What the rest of the engine asks of the mobile code: the primitives an auth connector may call, the
// per-device state file, and `vysu up|down` for a device. The signatures are the contract the web
// code and the platform commands call.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { deviceOrigin, devices, iosLock, type Platform } from '../core/hold.ts';
import { run, type RunResult } from '../core/proc.ts';
import { tool } from '../img/tools.ts';
import { ad, adCall, calls } from './agent.ts';
import { adb, androidAvdOf, androidSelect, androidSerial, captureOptions, emulatorSerials } from './device.ts';
import * as launch from './launch.ts';
import { metroPort as port } from './metro.ts';
import * as state from './state.ts';
import { emulatorPath } from './tools.ts';

// agent-device on the chosen simulator / emulator, under its lock, in this device's session.
export async function mob(platform: Platform, args: string[]): Promise<RunResult> {
  return ad(platform, args);
}
// Press by accessible label, else by visible text. True when something was pressed.
export async function mobPressIf(platform: Platform, label: string): Promise<boolean> {
  return launch.mobPressIf(platform, label);
}
// Press the first of those comma-separated labels that is there (a system dialog).
export async function mobPressAny(platform: Platform, labels: string): Promise<boolean> {
  return launch.mobPressAny(platform, labels);
}
// Press each of them that is there, in order.
export async function mobPressAll(platform: Platform, labels: string): Promise<boolean> {
  return launch.mobPressAll(platform, labels);
}
// Wait for a text to show up. True when it did.
export async function mobWaitText(platform: Platform, text: string, ms = 8000): Promise<boolean> {
  return (await adCall(platform, calls.waitText(text, ms))).ok;
}
// The text fields on screen, read from a capture rather than from the tree: a login form inside a
// system web surface (SafariViewService on iOS 18, a Chrome Custom Tab) is invisible to the platform's
// accessibility, and a connector that cannot read it has nothing else to aim at. The fields helper's
// JSON — boxes in points, top to bottom — or '' when it sees none, so a connector can say what it
// expected instead of tapping at a constant. Same 1x capture as `vysu mshot`: the boxes then come back
// in the points a press is given in.
export async function mobFields(platform: Platform): Promise<string> {
  mkdirSync(config().state, { recursive: true });
  const png = join(config().state, `fields-${platform}.png`);
  await adCall(platform, calls.screenshot(png, await captureOptions(platform)));
  const r = await tool('fields', [png, '--json']);
  return r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
}
// The app to open: VYSU_IOS_APP on iOS, the bundle on Android.
export function mobileApp(platform: Platform): string {
  return launch.mobileApp(platform);
}
// Whether this device's agent-device session is open: a look at the screen costs nothing then, and
// opening one first can cost a minute of runner build on iOS.
export async function mobileSessionOpen(platform: Platform): Promise<boolean> {
  return launch.sessionOpen(platform);
}
// The app killed and started straight onto its bundle, its first screen up and its session open.
export async function mobileRelaunch(platform: Platform): Promise<void> {
  return launch.mobileRelaunch(platform);
}
// The dev-client hand-off: the app on its JS bundle, not on the launcher.
export async function mobileLoadBundle(platform: Platform): Promise<void> {
  return launch.mobileLoadBundle(platform);
}
// The port of this owner's Metro.
export function metroPort(): string {
  return port();
}
// What an auth connector needs done before it opens the app —
// `ios_lock` on iOS, `android_select` then `adb reverse tcp:<metro_port> tcp:<metro_port>` on
// Android — so a connector never reaches for adb or the Metro port itself.
export async function mobilePrepare(platform: Platform): Promise<void> {
  if (platform === 'ios') {
    await iosLock();
    return;
  }
  await androidSelect();
  await adb(['reverse', `tcp:${port()}`, `tcp:${port()}`]);
}
// What was done to the device (persona, textsize, appearance, lang, net), read back by `vysu claim`.
export function mstateSet(platform: Platform, key: string, value: string): void {
  state.mstateSet(platform, key, value);
}
export function mstateGet(platform: Platform, key: string, fallback = ''): string {
  return state.mstateGet(platform, key, fallback);
}
// `vysu up ios|android [--build] [--reinstall] [--avd <n>] [--device <n>] [--isolated …]` and
// `vysu down metro|applog …`, called by the services command.
export async function mobileUp(platform: Platform, args: string[]): Promise<void> {
  return (await import('./up.ts')).mobileUp(platform, args);
}
export async function mobileDown(what: string, args: string[]): Promise<void> {
  return (await import('./up.ts')).mobileDown(what, args);
}
// For `vysu doctor`: one line per simulator / emulator and what the machine offers — the devices in
// force and where each choice comes from, the emulators attached, what each device was left in, and
// last the AVDs this machine has (doctor prints that one after the locks).
export async function mobileDoctorLines(): Promise<string[]> {
  const out: string[] = [];
  out.push(`ios device: ${devices.ios}${deviceOrigin('ios-device')}`);
  const serial = await androidSerial();
  out.push(`android avd: ${devices.android}${deviceOrigin('android-avd')} → ${serial || 'not running'}`);
  let attached = '';
  for (const s of await emulatorSerials()) attached += ` ${s}=${await androidAvdOf(s)}`;
  out.push(`emulators:${attached || ' (none attached)'}`);
  const expo = config().get('MOBILE_KIND', 'expo') === 'expo';
  let files: string[] = [];
  try {
    files = readdirSync(config().state)
      .filter((f) => f.startsWith('state-') && f.endsWith('.env'))
      .sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const d = f.slice('state-'.length, -'.env'.length);
    if (d.startsWith('ios-') || d.startsWith('android-')) out.push(await state.mstateLine(join(config().state, f), d, expo));
  }
  if (existsSync(emulatorPath())) {
    const r = await run(emulatorPath(), ['-list-avds']);
    out.push(`avds: ${r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((a) => `${a} `)
      .join('')}`);
  }
  return out;
}
// For `vysu doctor`: « push: <driver> — <what it does> », one line per driver VYSU_PUSH enables (the
// drivers live in src/push/).
export async function pushDescribeLines(): Promise<string[]> {
  return (await import('../push/push.ts')).pushDescribeLines();
}
