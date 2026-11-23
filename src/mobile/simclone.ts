// `simctl clone` copies the source's LaunchServices store as it is: in the clone, every app's bundle and
// data container still resolve to the source's folders (`simctl get_app_container` on the clone names
// the source). Every clone of a device then runs the app out of one shared data folder: one login for
// all of them, and a Firestore LevelDB the second app to open it aborts on (« Failed to open LevelDB
// database … LOCK: Resource temporarily unavailable »), seen on a Mac mini with three clones up
// (2026-11-23). Removed while the simulator is shut down, the store is rebuilt from the clone's own
// containers at its next boot, the installed apps and their data kept.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEVICE_PATH = /CoreSimulator\/Devices\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\//g;

export const simDeviceDir = (udid: string, root = join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices')): string => join(root, udid);

// The other simulators a LaunchServices store points into, by UDID.
export function foreignDevices(store: Buffer, udid: string): string[] {
  const found = new Set<string>();
  for (const m of store.toString('latin1').matchAll(DEVICE_PATH)) if (m[1] !== udid) found.add(m[1]!);
  return [...found];
}

// The stores of a shut-down simulator that point into another one, removed: the UDIDs they named, or []
// when the simulator owns its store (any simulator not made by `simctl clone`).
export function simStoreRepair(udid: string, deviceDir = simDeviceDir(udid)): string[] {
  const lsd = join(deviceDir, 'data', 'var', 'db', 'lsd');
  let names: string[];
  try {
    names = readdirSync(lsd).filter((n) => n.endsWith('.csstore'));
  } catch {
    return [];
  }
  const foreign = new Set<string>();
  for (const n of names) {
    let store: Buffer;
    try {
      store = readFileSync(join(lsd, n));
    } catch {
      continue;
    }
    for (const u of foreignDevices(store, udid)) foreign.add(u);
  }
  if (!foreign.size) return [];
  for (const n of names) rmSync(join(lsd, n), { force: true });
  return [...foreign];
}

// Before a shut-down simulator boots: its store repaired, and one line saying so when there was one.
export function simBootRepair(udid: string, name: string, print: (line: string) => void): void {
  const foreign = simStoreRepair(udid);
  if (foreign.length) print(`ios: « ${name} » still ran its apps out of ${foreign.join(', ')} (a simctl clone's app registry): reset, rebuilt at this boot`);
}
