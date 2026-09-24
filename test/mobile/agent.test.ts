import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceilingMs } from '../../src/mobile/agent.ts';

test('every agent-device call has a ceiling a minute past what it announces', () => {
  assert.equal(ceilingMs(['snapshot', '-i']), 120000);
  assert.equal(ceilingMs(['wait', 'text', 'Bienvenue', '8000']), 120000);
  assert.equal(ceilingMs(['open', 'Nidz (prep)', '--timeout', '180000']), 240000);
  assert.equal(ceilingMs(['press', '305', '45']), 120000);
});
