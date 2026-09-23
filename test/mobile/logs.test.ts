// The Metro and device log readers against what vysu 0.5 printed for the same log
// (fixtures/metro.expected, its answers on fixtures/metro.log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleErrorOf } from '../../src/mobile/metro.ts';
import { mlogFilter } from '../../src/mobile/mlog.ts';

const dir = join(import.meta.dirname, 'fixtures');
const log = readFileSync(join(dir, 'metro.log'), 'utf8');
const expected = readFileSync(join(dir, 'metro.expected'), 'utf8').split('\n');
const section = (name: string): string[] => {
  const at = expected.indexOf(`--- ${name}`);
  const end = expected.findIndex((l, i) => i > at && l.startsWith('--- '));
  return expected.slice(at + 1, end < 0 ? undefined : end).filter((l, i, a) => i < a.length - 1 || l !== '');
};
const ignore = '\\[boot |i18next is made possible';

test('a bundling failure since a line', () => {
  assert.deepEqual([bundleErrorOf(log, '/Users/x/proj/')], section('bundle error from 0'));
  assert.equal(bundleErrorOf(log.split('\n').slice(13).join('\n'), '/Users/x/proj/'), '');
});

test('mlog: plain, --errors, and VYSU_MLOG_IGNORE, as mlog_filter printed them', () => {
  assert.deepEqual(mlogFilter(log, false, ''), section('filter plain'));
  assert.deepEqual(mlogFilter(log, true, ''), section('filter errors'));
  assert.deepEqual(mlogFilter(log, true, ignore), section('filter errors ignore'));
  assert.deepEqual(mlogFilter(log, false, ignore), section('filter plain ignore'));
  assert.deepEqual(mlogFilter('', true, ''), []);
});
