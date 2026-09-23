// Addressing a simulator or an emulator: its UDID, its serial, its scale, all remembered per device
// under the state folder (files every version reads and writes alike, so two installed side by side
// share them).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { androidLock, devices, iosLock, type Platform } from '../core/hold.ts';
import { run, type RunOptions, type RunResult } from '../core/proc.ts';
import { pyRound } from '../core/py.ts';
import { slug, sleep } from '../core/text.ts';
import { adCall, calls } from './agent.ts';
import { pngSize, pyFloat } from './png.ts';
import { adbPath, crlf, xcrun } from './tools.ts';

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const remember = (p: string, v: string): void => {
  mkdirSync(config().state, { recursive: true });
  writeFileSync(p, v);
};

export const deviceOf = (p: Platform): string => devices.of(p);

// --- iOS ---------------------------------------------------------------------------------------

// `simctl … booted` is ambiguous once two simulators run: always address the chosen device's UDID.
// Resolving it costs a full `simctl list` (~1 s), so it is remembered per device name; `sim` forgets
// the file when simctl no longer knows that UDID (a simulator deleted or recreated meanwhile).
export async function iosUdid(refresh = false, name = devices.ios): Promise<string> {
  const f = join(config().state, `ios-udid-${slug(name)}`);
  if (refresh) rmSync(f, { force: true });
  const cached = read(f);
  if (cached) return cached;
  const r = await xcrun(['simctl', 'list', 'devices', 'available', '-j']);
  let udid = 'booted';
  try {
    const d = (JSON.parse(r.stdout) as { devices: Record<string, Array<{ name: string; udid: string }>> }).devices;
    outer: for (const list of Object.values(d)) {
      for (const x of list) {
        if (x.name === name) {
          udid = x.udid;
          break outer;
        }
      }
    }
  } catch {
    // simctl answered nothing readable: « booted », simctl's own name for the booted simulator
  }
  if (udid !== 'booted') remember(f, udid);
  return udid;
}

// xcrun simctl <verb> <the chosen simulator> …, retried once on a stale cached UDID. The output is
// stdout and stderr together, as `2>&1` gave it.
export async function sim(verb: string, args: string[] = [], opts: RunOptions = {}): Promise<{ code: number; out: string }> {
  await iosLock();
  const once = async (udid: string): Promise<{ code: number; out: string }> => {
    const r = await xcrun(['simctl', verb, udid, ...args], opts);
    return { code: r.code, out: `${r.stdout}${r.stderr}` };
  };
  let r = await once(await iosUdid());
  if (r.code !== 0 && /invalid device|unable to find|not found/i.test(r.out)) r = await once(await iosUdid(true));
  return r;
}

// The status bar is chrome, not UI, and it moves: the charging bolt pulses, so two captures of a
// still screen differ. Asked for once per session — it is honoured up to iOS 18 and silently dropped
// on the iOS 26 runtimes (`simctl status_bar list` comes back empty right after a successful
// override), which is why a capture is also compared with its battery corner masked (mshot).
export async function iosFreezeStatusBar(): Promise<void> {
  await sim('status_bar', ['override', '--time', '9:41', '--batteryState', 'discharging', '--batteryLevel', '100', '--wifiBars', '3', '--cellularBars', '4']);
}

// --- Android -----------------------------------------------------------------------------------

// `adb` picks « the » device and fails with « more than one device/emulator » as soon as a second
// emulator is attached: every android path resolves the serial of the AVD first, and every adb call
// (agent-device's own included, through ANDROID_SERIAL) addresses it.
export const serial = { value: '' };

export function adbRaw(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(adbPath(), args, opts);
}

// adb on the selected emulator.
export function adb(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return adbRaw(serial.value ? ['-s', serial.value, ...args] : args, opts);
}

// `adb shell …`, its answer without the carriage returns.
export async function adbShell(args: string[], opts: RunOptions = {}): Promise<string> {
  return crlf((await adb(['shell', ...args], opts)).stdout);
}

// Asking an emulator its AVD name costs a console round trip, so it is remembered per AVD and only
// looked up again when that serial stops answering.
export async function androidAvdOf(s: string): Promise<string> {
  const r = await adbRaw(['-s', s, 'emu', 'avd', 'name']);
  return crlf(r.stdout).split('\n')[0] ?? '';
}

export async function emulatorSerials(): Promise<string[]> {
  const r = await adbRaw(['devices']);
  const out: string[] = [];
  for (const line of crlf(r.stdout).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[0]?.startsWith('emulator-') && f[1] === 'device') out.push(f[0]);
  }
  return out;
}

// → emulator-NNNN, or '' when the AVD is not running. The cached serial is checked by name rather
// than by liveness: an emulator restarted while another one held 5554 comes back on another port,
// and the port it left is taken by its neighbour.
export async function androidSerial(avd = devices.android): Promise<string> {
  const f = join(config().state, `android-serial-${slug(avd)}`);
  const cached = read(f);
  if (cached) {
    if ((await androidAvdOf(cached)) === avd) return cached;
    rmSync(f, { force: true });
  }
  for (const s of await emulatorSerials()) {
    if ((await androidAvdOf(s)) !== avd) continue;
    remember(f, s);
    return s;
  }
  return '';
}

// What every android path starts with: the emulator is locked, then addressed.
export async function androidSelect(): Promise<string> {
  await androidLock();
  if (serial.value) return serial.value;
  serial.value = await androidSerial();
  if (!serial.value) die(`android: ${devices.android} is not running (vysu up android --avd ${devices.android})`);
  process.env.ANDROID_SERIAL = serial.value;
  return serial.value;
}

// A device switched to within one command (a matrix run): its serial is looked up again.
export function forgetSerial(): void {
  serial.value = '';
}

const bootCompleted = async (): Promise<boolean> => (await adbShell(['getprop', 'sys.boot_completed'])).trim() === '1';

// Bounded: a vanished device must not spin forever.
export async function waitAndroidBoot(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await bootCompleted()) return;
    await sleep(3000);
  }
  die(`android: emulator not booted after 4 min (see ${join(config().logs, 'android-emulator.log')})`);
}

// A zygote restart takes adbd with it: `sys.boot_completed` comes back as 1 while the shell still
// answers nothing, and a launch sent then is simply lost. Wait for a real command to answer too.
export async function waitAndroidShell(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await bootCompleted()) && (await adbShell(['dumpsys', 'window'])) !== '') return;
    await sleep(3000);
  }
  die('android: shell still not answering 2 min after the restart');
}

// `emulator -avd <name>` takes the next free even port (5554, 5556…), so the serial of the one just
// started is only known once it answers to its own name.
export async function waitAndroidSerial(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const s = await androidSerial();
    if (s) return s;
    await sleep(2000);
  }
  die(`android: ${devices.android} never showed up in adb devices (see ${join(config().logs, 'android-emulator.log')})`);
}

export async function androidSdkLevel(): Promise<number> {
  const v = (await adbShell(['getprop', 'ro.build.version.sdk'])).trim();
  return /^\d+$/.test(v) ? Number(v) : 0;
}

// --- scale -------------------------------------------------------------------------------------

// Pixels per point (iOS) or per dp (Android) of the running device, for the motion report and for
// capturing at 1x. Two screenshots to find out: remembered per device until `vysu cache clear`. The
// text is Python's (« 2.625 », « 3.0 », « 3 »), which every version reads back.
export async function mobileScale(p: Platform): Promise<string> {
  const f = join(config().state, `scale-${p}-${slug(devices.of(p))}`);
  const cached = read(f);
  if (cached) return cached;
  let scale: string;
  if (p === 'android') {
    await androidSelect();
    const d = /\d+/.exec(await adbShell(['wm', 'density']))?.[0] ?? '';
    scale = pyFloat(Number(d) / 160);
  } else {
    // agent-device captures at 1x and says that logical size (« (402x874 @1x) »); simctl captures
    // the device's pixels. Their ratio is the scale.
    const oneX = join(tmpdir(), `vysu-scale-1x-${process.pid}.png`);
    const full = join(tmpdir(), `vysu-scale-${process.pid}.png`);
    const a = await adCall('ios', calls.screenshot(oneX));
    await sim('io', ['screenshot', full]);
    let px = 0;
    try {
      px = pngSize(full).width;
    } catch {
      die('ios: the simulator gave no screenshot to read its scale from');
    }
    const logical = Number(a.data.width) || px;
    scale = String(pyRound(px / logical));
    rmSync(oneX, { force: true });
    rmSync(full, { force: true });
  }
  remember(f, scale);
  return scale;
}

// What a 1x capture asks of agent-device. iOS captures at 1x already, and has its clock and bars
// repainted (the battery is masked at diff time); Android hands back device pixels — 1080x2400 on a
// Pixel 8, three times the tokens of the same picture in dp, and boxes a report in pixels the rest of
// vysu counts in dp.
export async function captureOptions(p: Platform): Promise<{ scale?: string; normalizeStatusBar?: boolean }> {
  if (p === 'ios') return { normalizeStatusBar: true };
  return { scale: pyFloat(pyRound(1 / Number(await mobileScale(p)), 4)) };
}
