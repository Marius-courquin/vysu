import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adbSerial, simctlRest } from '../../src/mobile/passargs.ts';

const UDID = 'EDAE8BF1-9DF8-4637-A9E2-AD471BD0B869';

test('a simulator the agent named again is dropped when it is the owner\'s, refused when not', () => {
  assert.deepEqual(simctlRest(['override', '--time', '9:41'], UDID), ['override', '--time', '9:41']);
  assert.deepEqual(simctlRest([UDID, 'override', '--time', '9:41'], UDID), ['override', '--time', '9:41']);
  assert.deepEqual(simctlRest([UDID.toLowerCase(), 'screenshot', 'x.png'], UDID), ['screenshot', 'x.png']);
  assert.deepEqual(simctlRest(['booted', 'screenshot', 'x.png'], UDID), ['screenshot', 'x.png']);
  assert.deepEqual(simctlRest(['38297C36-68A8-41B5-B9C1-71C554B57BB3'], UDID), { refused: '38297C36-68A8-41B5-B9C1-71C554B57BB3' });
  assert.deepEqual(simctlRest([], UDID), []);
});

test('a leading -s is taken out of adb\'s arguments', () => {
  assert.deepEqual(adbSerial(['-s', 'emulator-5554', 'shell', 'ls']), { serial: 'emulator-5554', rest: ['shell', 'ls'] });
  assert.deepEqual(adbSerial(['-semulator-5554', 'get-state']), { serial: 'emulator-5554', rest: ['get-state'] });
  assert.deepEqual(adbSerial(['shell', '-s']), { serial: '', rest: ['shell', '-s'] });
});
