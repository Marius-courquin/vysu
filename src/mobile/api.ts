// What the rest of the engine asks of the mobile code: the primitives an auth connector may call, the
// per-device state file, and `vysu up|down` for a device. Owned by the mobile lot; the bodies below are
// placeholders until it lands, and their signatures are the contract the web and platform lots code to.
import type { Platform } from '../core/hold.ts';
import type { RunResult } from '../core/proc.ts';

const notYet = (what: string): never => {
  throw new Error(`${what}: the mobile code is not ported yet`);
};

// agent-device on the chosen simulator / emulator, under its lock, in this device's session.
export async function mob(platform: Platform, args: string[]): Promise<RunResult> {
  return notYet(`mob ${platform} ${args.join(' ')}`);
}
// Press by accessible label, else by visible text. True when something was pressed.
export async function mobPressIf(platform: Platform, label: string): Promise<boolean> {
  return notYet(`mob_press_if ${platform} ${label}`);
}
// Press the first of those comma-separated labels that is there (a system dialog).
export async function mobPressAny(platform: Platform, labels: string): Promise<boolean> {
  return notYet(`mob_press_any ${platform} ${labels}`);
}
// Press each of them that is there, in order.
export async function mobPressAll(platform: Platform, labels: string): Promise<void> {
  return notYet(`mob_press_all ${platform} ${labels}`);
}
// Wait for a text to show up. True when it did.
export async function mobWaitText(platform: Platform, text: string, ms = 8000): Promise<boolean> {
  return notYet(`mob_wait_text ${platform} ${text} ${ms}`);
}
// The text fields read from a capture, JSON boxes in points, top to bottom.
export async function mobFields(platform: Platform): Promise<string> {
  return notYet(`mob_fields ${platform}`);
}
// The app to open: VYSU_IOS_APP on iOS, the bundle on Android.
export function mobileApp(platform: Platform): string {
  return notYet(`mobile_app ${platform}`);
}
// The dev-client hand-off: the app on its JS bundle, not on the launcher.
export async function mobileLoadBundle(platform: Platform): Promise<void> {
  return notYet(`mobile_load_bundle ${platform}`);
}
// What was done to the device (persona, textsize, appearance, lang, net), read back by `vysu claim`.
export function mstateSet(platform: Platform, key: string, value: string): void {
  return notYet(`mstate_set ${platform} ${key} ${value}`);
}
export function mstateGet(platform: Platform, key: string, fallback = ''): string {
  return notYet(`mstate_get ${platform} ${key} ${fallback}`);
}
// `vysu up ios|android [--build] [--reinstall] [--avd <n>] [--device <n>] [--isolated …]` and
// `vysu down metro|applog …`, called by the services command.
export async function mobileUp(platform: Platform, args: string[]): Promise<void> {
  return notYet(`up ${platform} ${args.join(' ')}`);
}
export async function mobileDown(what: string, args: string[]): Promise<void> {
  return notYet(`down ${what} ${args.join(' ')}`);
}
// For `vysu doctor`: one line per simulator / emulator and what the machine offers.
export async function mobileDoctorLines(): Promise<string[]> {
  return notYet('doctor mobile');
}
