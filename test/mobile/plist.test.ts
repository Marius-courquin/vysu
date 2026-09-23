// Property lists as plistlib wrote them (fixtures made by Python), read, edited and written back, and
// the BulletinBoard edit `vysu mperm ios notifications` makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBplist, parseBplist, readPlistFile, Real, Uid, type PDict } from '../../src/mobile/bplist.ts';
import { bulletin } from '../../src/mobile/mctl.ts';
import { isMac } from '../../src/core/host.ts';

const fixture = join(import.meta.dirname, 'fixtures', 'bulletin.plist');

test('a binary plist from plistlib, every type', () => {
  const top = parseBplist(readFileSync(fixture)) as PDict;
  assert.equal(top.version, 2);
  assert.ok(top.ratio instanceof Real && top.ratio.value === 0.5);
  assert.ok(top.when instanceof Date);
  assert.equal(top.name, 'Élan 😀');
  assert.deepEqual(top.list, [1, -3, 70000, 2 ** 40]);
  const sections = top.sectionInfo as PDict;
  assert.deepEqual([...(sections['com.apple.Other'] as Uint8Array)], [0, 1]);
  const archive = parseBplist(sections['fr.example.app'] as Uint8Array) as PDict;
  assert.ok((archive.$top as PDict).root instanceof Uid);
});

test('written back, it reads the same', () => {
  const top = parseBplist(readFileSync(fixture));
  assert.deepEqual(parseBplist(buildBplist(top)), top);
  const big: PDict = { list: Array.from({ length: 300 }, (_, i) => `item ${i}`), nested: { a: [true, false, null, new Uid(300)] } };
  assert.deepEqual(parseBplist(buildBplist(big)), big);
});

test('notifications granted, denied, reset and granted again from the kept section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-bb-'));
  const file = join(dir, 'VersionedSectionInfo.plist');
  const saved = join(dir, 'saved.section');
  copyFileSync(fixture, file);
  assert.equal(await bulletin(file, 'fr.example.app', 'read', saved), 'granted');
  assert.equal(await bulletin(file, 'fr.example.app', 'deny', saved), '');
  assert.equal(await bulletin(file, 'fr.example.app', 'read', saved), 'denied');
  assert.equal(await bulletin(file, 'fr.example.app', 'reset', saved), '');
  assert.equal(await bulletin(file, 'fr.example.app', 'read', saved), 'not asked');
  assert.ok(existsSync(saved));
  assert.equal(await bulletin(file, 'fr.example.app', 'grant', saved), '');
  assert.equal(await bulletin(file, 'fr.example.app', 'read', saved), 'granted');
  assert.equal(await bulletin(file, 'fr.never.asked', 'grant', join(dir, 'none')), 'none');
  const top = parseBplist(readFileSync(file)) as PDict;
  assert.deepEqual([...((top.sectionInfo as PDict)['com.apple.Other'] as Uint8Array)], [0, 1]);
});

test('an XML plist goes through plutil', { skip: !isMac }, async () => {
  const xml = join(import.meta.dirname, 'fixtures', 'bulletin-xml.plist');
  assert.deepEqual(await readPlistFile(xml), parseBplist(readFileSync(fixture)));
});
