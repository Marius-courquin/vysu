// The platform tools a device is driven with, found the same way on every machine: adb and the
// emulator from the Android SDK (`.exe` on Windows), xcrun on a Mac. iOS needs Xcode's simulators,
// which only a Mac has: an iOS command elsewhere says so in one line instead of failing on a
// missing xcrun.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { isMac, isWindows, which } from '../core/host.ts';
import { run, type RunOptions, type RunResult } from '../core/proc.ts';

const exe = (name: string): string => (isWindows ? `${name}.exe` : name);

let adbCached = '';
export function adbPath(): string {
  if (adbCached) return adbCached;
  const inSdk = join(config().androidSdk, 'platform-tools', exe('adb'));
  adbCached = which('adb') || (existsSync(inSdk) ? inSdk : 'adb');
  return adbCached;
}

export function emulatorPath(): string {
  return join(config().androidSdk, 'emulator', exe('emulator'));
}

export function needMac(what: string): void {
  if (!isMac) die(`${what}: iOS simulators need macOS and Xcode, and this machine runs ${process.platform}`);
}

export function xcrun(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  needMac('ios');
  return run('xcrun', args, opts);
}

// `tr -d '\r'`: adb shell on some hosts answers in CRLF.
export const crlf = (s: string): string => s.replace(/\r/g, '');
