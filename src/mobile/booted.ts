// A simulator agent-device is asked to drive while it is shut down is booted by agent-device itself,
// and Simulator.app opened with it: past VYSU_IOS_MAX_BOOTED, past the memory floor, past
// VYSU_MOBILE_HEADLESS. Now that idle simulators are shut down (mobile/reap.ts), the next command of
// an agent that had left its device for a while would bring it back that way. The Android side has
// always refused a stopped emulator (androidSelect); the iOS side now does too, once per command, from
// the simulator's own device.plist (state 1: shut down, 3: booted), which costs no simctl call.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { die } from '../core/errors.ts';
import { devices } from '../core/hold.ts';
import { readPlistFile, type PDict } from './bplist.ts';
import { iosUdid } from './device.ts';

export const SIM_SHUTDOWN = 1;

export function simState(plist: unknown): number {
  const v = plist && typeof plist === 'object' && !Array.isArray(plist) ? (plist as PDict).state : undefined;
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

let checked = false;
export async function iosNeedBooted(): Promise<void> {
  if (checked) return;
  checked = true;
  const udid = await iosUdid();
  if (udid === 'booted') return;
  let plist: unknown;
  try {
    plist = await readPlistFile(join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid, 'device.plist'));
  } catch {
    return;
  }
  if (simState(plist) === SIM_SHUTDOWN) die(`ios: « ${devices.ios} » is shut down`, 'vysu up ios (boots it, when there is room: vysu devices)');
}
