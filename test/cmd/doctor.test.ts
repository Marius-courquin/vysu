import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProblem } from '../../src/cmd/doctor.ts';

test('doctor --brief keeps the lines that say something is missing or broken', () => {
  assert.equal(isProblem('✓ agent-browser: 0.38.1'), false);
  assert.equal(isProblem('  VYSU_ORIGIN = http://localhost:8100 (config)'), false);
  assert.equal(isProblem('! skills: 0.9.1, engine 0.9.2 → vysu init --refresh-skills'), true);
  assert.equal(isProblem('\x1b[31m✗\x1b[0m agent-device: missing → npm i -g agent-device'), true);
  assert.equal(isProblem('personas: MISSING (/x/personas.env)'), true);
  assert.equal(isProblem('devices: (unavailable — boom)'), true);
  assert.equal(isProblem('! config: none found — anonymous web captures only → vysu init'), true);
  // Missing until the first video, by design.
  assert.equal(isProblem('remotion: node_modules MISSING (installed on the first vysu video)'), false);
});
