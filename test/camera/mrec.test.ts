import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MREC_USAGE, recorderSaid } from '../../src/mobile/rec.ts';

test('a recorder that did not start is quoted by its last line, its notes aside', () => {
  assert.equal(recorderSaid('Note: No --type given\nError: Host recording is already in progress\n'), 'Error: Host recording is already in progress');
  assert.equal(recorderSaid('ERROR: unable to create video/avc codec\nNote: trailing\n'), 'ERROR: unable to create video/avc codec');
  assert.equal(recorderSaid(''), '');
  assert.equal(recorderSaid('Note: only notes\n'), '');
});

test('mrec says it takes --strict', () => {
  assert.match(MREC_USAGE, /\[--crop x,y,w,h\] \[--strict\] -- "<step>" …$/);
});
