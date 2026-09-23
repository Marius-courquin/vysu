import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoFilter } from '../../src/img/motion.ts';

test('a crop is cut at the size asked, odd or not', () => {
  assert.equal(videoFilter(60, ''), 'fps=60');
  assert.equal(videoFilter(60, '1179:600:0:300'), 'fps=60,crop=1179:600:0:300:exact=1');
});
