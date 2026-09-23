import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiLabel } from '../../src/services/services.ts';
import { run } from '../../src/core/proc.ts';

test('the API a service was started against, by its label', () => {
  const hosts = 'localhost:8080=local api.example.com=staging';
  assert.equal(apiLabel(['VITE_API_URL=http://localhost:8080'], hosts), 'local');
  assert.equal(apiLabel(['PORT=3000', 'API=https://api.example.com/v1/x'], hosts), 'staging');
  assert.equal(apiLabel(['API=https://other.example.com/'], hosts), 'other.example.com');
  // The last url wins, as each one overwrote the file.
  assert.equal(apiLabel(['A=http://localhost:8080', 'B=https://api.example.com'], hosts), 'staging');
  assert.equal(apiLabel(['PORT=3000'], hosts), '');
  // Only http(s) loses its scheme: a ws url keeps the part before its first slash.
  assert.equal(apiLabel(['WS=ws://h:1/x'], hosts), 'ws:');
});

// A STOP command that leaves a process in the background (`nohup … &`) kept `vysu down` waiting as
// long as that process ran: it held the pipe the output was read through. 0.5.1 sent it to /dev/null.
test('a command whose output is discarded is done when it exits, whatever it left running', async () => {
  const leaveOne = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit' }).unref()";
  const t0 = performance.now();
  const r = await run(process.execPath, ['-e', leaveOne], { discard: true });
  assert.equal(r.code, 0);
  assert.ok(performance.now() - t0 < 2000, `waited ${Math.round(performance.now() - t0)} ms`);
});
