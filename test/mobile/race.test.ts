// Two agents doing the same thing at the same moment, each in a process of its own: whatever one of
// them has picked, the other must see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = join(import.meta.dirname, 'race-helper.mjs');

function contender(state: string, who: string, args: string[]): Promise<string> {
  const env = { ...process.env, VYSU_STATE: state, VYSU_PROJECT_DIR: state, VYSU_OWNER: who, VYSU_LOCK_WAIT: '10' };
  return new Promise((resolve) => {
    let out = '';
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', helper, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.on('data', (b: Buffer) => (out += b.toString()));
    c.on('close', () => resolve(out.trim()));
  });
}

// Nothing listens on the port picked: the reservation only reads, and no Metro is started.
test('two isolated Metros started together get two ports, each on record', async () => {
  for (let n = 0; n < 3; n++) {
    const state = mkdtempSync(join(tmpdir(), 'vysu-metro-race-'));
    const app = join(state, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), '{}');
    const a = contender(state, 'owner-a', ['metro', app]);
    await new Promise((r) => setTimeout(r, 3));
    const [pa, pb] = await Promise.all([a, contender(state, 'owner-b', ['metro', app])]);
    assert.match(pa, /^80[89][0-9]$/, pa);
    assert.match(pb, /^80[89][0-9]$/, pb);
    assert.notEqual(pa, pb);
    const records = readdirSync(state)
      .filter((f) => f.startsWith('metro-port.'))
      .map((f) => readFileSync(join(state, f), 'utf8').split(' ').slice(0, 2).join(' '))
      .sort();
    assert.deepEqual(records, [`${pa} 0`, `${pb} 0`].sort());
  }
});

// The first owner is between its check and its write (a clone takes seconds under the same lock):
// the second one's named claim waits for it, then finds the device claimed.
test('a named claim waits on the pool lock, then sees the claim made under it', async () => {
  const state = mkdtempSync(join(tmpdir(), 'vysu-claim-race-'));
  const a = contender(state, 'owner-a', ['slow-claim', 'android-fake-avd']);
  await new Promise((r) => setTimeout(r, 300));
  const [sa, sb] = await Promise.all([a, contender(state, 'owner-b', ['claim', 'android-fake-avd'])]);
  assert.equal(sa, 'claimed');
  assert.match(sb, /^died: android-fake-avd claimed by owner-a until /);
  assert.match(readFileSync(join(state, 'claims', 'android-fake-avd'), 'utf8'), /^owner=owner-a$/m);
});
