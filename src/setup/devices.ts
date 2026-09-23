// The simulators and emulators `vysu setup` reports on, and creates when asked to: the iPhone pair
// (recent, and an old one on iOS 18) and the AVD specs of VYSU_ANDROID_AVDS.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { machine } from 'node:os';
import { join } from 'node:path';
import { HOME } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { isMac, isWindows, which } from '../core/host.ts';
import { run, runTool } from '../core/proc.ts';
import { info, ok, warn } from '../core/ui.ts';
import { installHint } from './hints.ts';

export interface AvdSpec {
  name: string;
  api: string;
  device: string;
  extra: string;
}

// `name:api:device:extra key=value …`, separated by « ; ». Split the way bash's parameter expansion
// did it: the name up to the first colon, the api up to the next, the device up to the next, the
// rest (colons included) is the extra.
export function avdSpecs(specs: string): AvdSpec[] {
  const out: AvdSpec[] = [];
  for (const spec of specs.split(';')) {
    if (!spec) continue;
    const first = spec.indexOf(':');
    const name = first < 0 ? spec : spec.slice(0, first);
    let rest = first < 0 ? spec : spec.slice(first + 1);
    const cut = (s: string): [string, string] => {
      const at = s.indexOf(':');
      return at < 0 ? [s, s] : [s.slice(0, at), s.slice(at + 1)];
    };
    let api: string;
    let device: string;
    [api, rest] = cut(rest);
    [device, rest] = cut(rest);
    out.push({ name, api, device, extra: rest });
  }
  return out;
}

// --- ios ---------------------------------------------------------------------------------------

async function xcrun(args: string[]): Promise<{ code: number; stdout: string }> {
  return run('xcrun', args);
}

// The newest iOS 18 runtime installed: the pre-redesign iPhone the old-phone check runs on.
export function ios18Runtime(json: string): string {
  try {
    const runtimes = (JSON.parse(json) as { runtimes?: Array<{ platform?: string; version?: string; identifier?: string }> }).runtimes ?? [];
    const rs = runtimes.filter((r) => r.platform === 'iOS' && (r.version ?? '').startsWith('18.'));
    return rs[rs.length - 1]?.identifier ?? '';
  } catch {
    return '';
  }
}

export interface IosProbe {
  available: string;
  runtimes: string;
  all: string;
}

// What the simulators are, asked all at once: each `simctl list` costs a third of a second or more.
export async function iosProbe(): Promise<IosProbe | undefined> {
  if (!isMac || !which('xcrun')) return undefined;
  const [available, runtimes, all] = await Promise.all([
    xcrun(['simctl', 'list', 'devices', 'available']),
    xcrun(['simctl', 'list', 'runtimes', 'available', '-j']),
    xcrun(['simctl', 'list', 'devices']),
  ]);
  return { available: available.stdout, runtimes: runtimes.stdout, all: all.stdout };
}

export async function iosSection(probe: IosProbe | undefined, wantOld: string, dry: boolean): Promise<void> {
  if (!isMac) {
    info('ios: macOS only — the iOS simulator runs on Xcode');
    return;
  }
  if (!probe) {
    warn('ios: Xcode missing — optional, unlocks every iOS check', installHint('xcode'));
    return;
  }
  const iphones = probe.available.split('\n').filter((l) => l.includes('iPhone')).length;
  if (iphones > 0) ok(`simulators: ${iphones} iPhone available`);
  else warn('simulators: none — optional, iOS checks only', 'open -a Simulator');
  const rt = ios18Runtime(probe.runtimes);
  const type = 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation';
  if (!rt) warn('ios 18: runtime missing — optional, unlocks the pre-redesign iPhone (8.9 GB)', 'xcodebuild -downloadPlatform iOS -buildVersion 18.6');
  else if (probe.all.includes(wantOld)) ok(`ios: « ${wantOld} » present`);
  else if (dry) warn(`ios: « ${wantOld} » missing — optional, the old-phone check`, 'vysu setup --yes');
  else if ((await xcrun(['simctl', 'create', wantOld, type, rt])).code === 0) ok(`ios: « ${wantOld} » created (iPhone SE 3rd gen, ${rt})`);
  else warn(`ios: « ${wantOld} » could not be created — optional`, `xcrun simctl create '${wantOld}' ${type} ${rt}`);
}

// --- android -----------------------------------------------------------------------------------

function sdkTool(sdk: string, name: string): string {
  return join(sdk, 'cmdline-tools', 'latest', 'bin', isWindows ? `${name}.bat` : name);
}

export function emulatorPath(): string {
  return join(config().androidSdk, 'emulator', isWindows ? 'emulator.exe' : 'emulator');
}

export async function androidSection(wantAvds: string, dry: boolean): Promise<void> {
  const sdk = config().androidSdk;
  const avdm = sdkTool(sdk, 'avdmanager');
  if (!existsSync(avdm)) {
    warn('android sdk: missing — optional, unlocks every Android check', installHint('android'));
    return;
  }
  const sdkm = sdkTool(sdk, 'sdkmanager');
  const abi = machine() === 'x86_64' ? 'x86_64' : 'arm64-v8a';
  const logs = config().logs;
  for (const { name, api, device, extra } of avdSpecs(wantAvds)) {
    if (existsSync(join(HOME, '.android', 'avd', `${name}.avd`))) {
      ok(`avd ${name}: present`);
      continue;
    }
    if (dry) {
      warn(`avd ${name}: missing — optional, one Android device`, 'vysu setup --yes');
      continue;
    }
    const image = `system-images;android-${api};google_apis;${abi}`;
    const log = join(logs, `sdk-api${api}.log`);
    if (!existsSync(join(sdk, 'system-images', `android-${api}`, 'google_apis', abi))) {
      info(`avd ${name}: downloading ${image}…`);
      mkdirSync(logs, { recursive: true });
      // The licences: sdkmanager asks for each, and `yes` answered them all.
      const r = await runTool(sdkm, ['--install', image], { input: 'y\n'.repeat(50) });
      writeFileSync(log, r.stdout + r.stderr);
    }
    const created = await runTool(avdm, ['create', 'avd', '-n', name, '-k', image, '-d', device, '--force'], { input: 'no\n' });
    if (created.code !== 0) {
      warn(`avd ${name}: creation failed — see ${log}`, 'vysu setup --yes');
      continue;
    }
    // An AVD ships with the GPU off and 1.5 GB: software rendering, ANRs at boot.
    const lines = ['hw.ramSize = 4096', 'hw.gpu.enabled = yes', 'hw.gpu.mode = host', 'hw.cpu.ncore = 4', 'hw.keyboard = yes'];
    for (const kv of extra.split(/\s+/).filter(Boolean)) {
      const eq = kv.indexOf('=');
      lines.push(eq < 0 ? `${kv} = ${kv}` : `${kv.slice(0, eq)} = ${kv.slice(eq + 1)}`);
    }
    appendFileSync(join(HOME, '.android', 'avd', `${name}.avd`, 'config.ini'), `${lines.join('\n')}\n`);
    ok(`avd ${name}: created`);
  }
}
