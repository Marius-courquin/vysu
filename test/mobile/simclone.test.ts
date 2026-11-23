// A simctl clone's LaunchServices store, still pointing into its source: found and removed before the
// clone boots, and nothing touched on a simulator that owns its store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foreignDevices, simStoreRepair } from '../../src/mobile/simclone.ts';

const SRC = '3DE73E1B-435F-41E4-AEA4-2818D39FC4FA';
const CLONE = '42602CE2-BABB-4CD3-BE2A-6E206F7E7F86';
const at = (udid: string): string => `/Users/x/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Data/Application/10B34E91-9DE3-4D5D-AF57-4F65D6076149`;
const store = (...paths: string[]): Buffer => Buffer.concat([Buffer.from([0, 1, 2, 255]), ...paths.map((p) => Buffer.from(`\0${p}\0`, 'latin1'))]);

function device(udid: string, stores: Record<string, Buffer>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'vysu-simclone-')), udid);
  const lsd = join(dir, 'data', 'var', 'db', 'lsd');
  mkdirSync(lsd, { recursive: true });
  for (const [n, b] of Object.entries(stores)) writeFileSync(join(lsd, n), b);
  writeFileSync(join(lsd, 'com.apple.LaunchServices.InstallJournal'), 'journal');
  return dir;
}

test('foreignDevices: the other simulators a store points into, its own left out', () => {
  assert.deepEqual(foreignDevices(store(at(SRC), at(SRC), at(CLONE)), CLONE), [SRC]);
  assert.deepEqual(foreignDevices(store(at(CLONE)), CLONE), []);
  assert.deepEqual(foreignDevices(Buffer.from('no path at all'), CLONE), []);
});

test('simStoreRepair: a clone pointing into its source loses its stores, and only them', () => {
  const dir = device(CLONE, { 'com.apple.LaunchServices-35651614-v2.csstore': store(at(SRC)), 'SystemDataOnly-com.apple.LaunchServices-35651614-v2.csstore': store(at(CLONE)) });
  assert.deepEqual(simStoreRepair(CLONE, dir), [SRC]);
  const lsd = join(dir, 'data', 'var', 'db', 'lsd');
  assert.ok(!existsSync(join(lsd, 'com.apple.LaunchServices-35651614-v2.csstore')));
  assert.ok(!existsSync(join(lsd, 'SystemDataOnly-com.apple.LaunchServices-35651614-v2.csstore')));
  assert.ok(existsSync(join(lsd, 'com.apple.LaunchServices.InstallJournal')));
});

test('simStoreRepair: a simulator that owns its store, or has none, is left as it is', () => {
  const own = device(SRC, { 'com.apple.LaunchServices-35651614-v2.csstore': store(at(SRC)) });
  assert.deepEqual(simStoreRepair(SRC, own), []);
  assert.ok(existsSync(join(own, 'data', 'var', 'db', 'lsd', 'com.apple.LaunchServices-35651614-v2.csstore')));
  assert.deepEqual(simStoreRepair(SRC, join(tmpdir(), 'vysu-no-such-device')), []);
});
