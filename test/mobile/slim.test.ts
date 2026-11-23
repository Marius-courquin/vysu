// VYSU_IOS_SLIM: what simslim is asked, and what tells a simulator already slimmed from one to slim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slimArgs, slimSignature } from '../../src/mobile/slim.ts';

const UDID = '42602CE2-BABB-4CD3-BE2A-6E206F7E7F86';

test("slimArgs: simslim's default profile, or a profile file, the boot state kept", () => {
  assert.deepEqual(slimArgs(UDID, 'default', ''), ['on', UDID, '--preserve-boot-state']);
  assert.deepEqual(slimArgs(UDID, '.vysu/simslim.json', '/p/.vysu/simslim.json'), ['on', UDID, '--preserve-boot-state', '--profile', '/p/.vysu/simslim.json']);
});

test('slimSignature: a clone made again under the same name, or an edited profile, is slimmed again', () => {
  assert.equal(slimSignature(UDID, 'default', '', 0), `${UDID}:default`);
  const before = slimSignature(UDID, 'x.json', '/p/x.json', 1000.4);
  assert.equal(before, `${UDID}:/p/x.json@1000`);
  assert.notEqual(slimSignature(UDID, 'x.json', '/p/x.json', 2000), before);
  assert.notEqual(slimSignature('0000AAAA-BABB-4CD3-BE2A-6E206F7E7F86', 'x.json', '/p/x.json', 1000), before);
});
