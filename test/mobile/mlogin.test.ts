// What the Auth0 connector does when a loaded machine gets in the way of an mlogin, against a fake
// context: a door slow to show, an ANR dialog over the Custom Tab, no logout within reach, Auth0's
// fields missing from the tree, a fill that does not take. The failures are the audit's (2026-10-12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthContext, Box } from '../../src/auth/types.ts';
import { connector as auth0, fillField } from '../../src/connectors/auth/auth0.ts';

interface Script {
  // How many times each mobTry call (joined) fails before it works, and what it prints then.
  failing?: Record<string, { times?: number; said?: string }>;
  // Whether a wait for that text, the nth time it is asked (from 1), sees it.
  sees?: (text: string, nth: number) => boolean;
  fields?: Box[];
  anr?: string;
  reset?: boolean;
  cfg?: Record<string, string>;
}

function fake(s: Script = {}): { v: AuthContext; calls: string[] } {
  const calls: string[] = [];
  const asked = new Map<string, number>();
  const left = new Map(Object.entries(s.failing ?? {}).map(([k, f]) => [k, f.times ?? Infinity]));
  const sees = s.sees ?? (() => true);
  const v: AuthContext = {
    web: async () => '',
    webTry: async () => ({ code: 0, stdout: '', stderr: '' }),
    webClickAny: async () => true,
    async mob(p, ...args) {
      calls.push(`mob ${p} ${args.join(' ')}`);
      return '';
    },
    async mobTry(p, ...args) {
      const call = `${p} ${args.join(' ')}`;
      calls.push(`try ${call}`);
      const n = left.get(call) ?? 0;
      if (n <= 0) return { code: 0, stdout: '', stderr: '' };
      left.set(call, n - 1);
      return { code: 1, stdout: '', stderr: s.failing?.[call]?.said ?? '' };
    },
    async mobPressIf(p, label) {
      calls.push(`pressIf ${p} ${label}`);
      return true;
    },
    async mobPressAny(p, labels) {
      calls.push(`pressAny ${p} ${labels}`);
      return false;
    },
    async mobPressAll(p, labels) {
      calls.push(`pressAll ${p} ${labels}`);
    },
    async mobWaitText(p, text, ms) {
      calls.push(`wait ${p} ${text} ${ms}`);
      const nth = (asked.get(text) ?? 0) + 1;
      asked.set(text, nth);
      return sees(text, nth);
    },
    async mobFields(p) {
      calls.push(`fields ${p}`);
      return s.fields ?? [];
    },
    mobileApp: () => 'fr.nidz',
    async mobileRelaunch(p) {
      calls.push(`relaunch ${p}`);
    },
    async mobileLoadBundle() {},
    async mobilePrepare(p) {
      calls.push(`prepare ${p}`);
    },
    async mobileUnblock(p) {
      calls.push(`unblock ${p}`);
      const pkg = s.anr ?? '';
      s.anr = '';
      return pkg;
    },
    async mobileReset(p) {
      calls.push(`reset ${p}`);
      return !!s.reset;
    },
    mstateSet(p, k, value) {
      calls.push(`mstate ${p} ${k}=${value}`);
    },
    personaRequire: () => ({ email: 'a@b.fr', password: 'pw' }),
    personaVar: () => '',
    cfg: (k, d = '') => s.cfg?.[k] ?? d,
    labels: (l) => l.split(',').map((x) => x.trim()).filter(Boolean),
    die(m): never {
      throw new Error(`die: ${m}`);
    },
    log: () => undefined,
    step: () => undefined,
    async sleep(n) {
      calls.push(`sleep ${n}`);
    },
    lastLine: (t) => t,
    value: (t) => t,
  };
  return { v, calls };
}

async function quietly(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines;
}

test('a door slow to show is waited for in turns with the signed-in marker, within VYSU_AUTH0_DOOR_WAIT', async () => {
  // The door shows on the third look: no logout, no relaunch on the way.
  const slow = fake({ sees: (t, n) => t === 'Se connecter' && n >= 3 ? true : t !== 'Se connecter' && t !== 'Menu' });
  await quietly(() => auth0.mobileLogin(slow.v, 'android', 'alice'));
  const from = slow.calls.indexOf('pressAny android Autoriser,Allow') + 1;
  assert.deepEqual(slow.calls.slice(from, from + 6), [
    'wait android Se connecter 4000',
    'wait android Menu 1500',
    'wait android Se connecter 4000',
    'wait android Menu 1500',
    'wait android Se connecter 4000',
    'pressIf android Se connecter',
  ]);
  // Neither ever shows: the budget bounds the looks (8 s: two turns, the second one shorter).
  const never = fake({ cfg: { AUTH0_DOOR_WAIT: '8' }, sees: (t) => t !== 'Se connecter' && t !== 'Menu' && t !== 'Se déconnecter' });
  await assert.rejects(auth0.mobileLogin(never.v, 'ios', 'alice'), /die: ios: not on the door screen and no way to log out from here$/);
  const doors = never.calls.filter((c) => c.startsWith('wait ios Se connecter') || c === 'wait ios Menu 1500');
  assert.deepEqual(doors.slice(0, 4), ['wait ios Se connecter 4000', 'wait ios Menu 1500', 'wait ios Se connecter 2500', 'wait ios Menu 1500']);
});

test('android with no logout within reach: the app data cleared, then the door', async () => {
  // Signed in, and no « Se déconnecter » anywhere; after the reset, the door.
  let reset = false;
  const f = fake({ reset: true, sees: (t) => (t === 'Se connecter' ? reset : t === 'Menu' ? !reset : t !== 'Se déconnecter') });
  const base = f.v.mobileReset;
  f.v.mobileReset = async (p) => ((reset = true), base(p));
  const out = await quietly(() => auth0.mobileLogin(f.v, 'android', 'alice'));
  assert.ok(f.calls.includes('reset android'), f.calls.join('\n'));
  assert.equal(f.calls.filter((c) => c === 'pressIf android Se connecter').length, 1);
  assert.deepEqual(out, ['android: logged in as alice (a@b.fr)']);
  // A reset that cannot be done (or that brings no door) ends the login, saying what was tried.
  const no = fake({ sees: (t) => t !== 'Se connecter' && t !== 'Se déconnecter' });
  await assert.rejects(auth0.mobileLogin(no.v, 'android', 'alice'), /die: android: not on the door screen and no way to log out from here \(nor after clearing the app data\)/);
});

test('an ANR dialog over the Custom Tab: answered, and the form looked for again', async () => {
  const f = fake({
    anr: 'com.android.chrome',
    failing: { 'android wait role="textfield" 20000': { times: 1 }, 'android wait id="username" 8000': { times: 1 } },
  });
  await quietly(() => auth0.mobileLogin(f.v, 'android', 'alice'));
  const at = f.calls.indexOf('unblock android');
  assert.deepEqual(f.calls.slice(at - 2, at + 3), [
    'try android wait role="textfield" 20000',
    'try android wait id="username" 8000',
    'unblock android',
    'try android wait role="textfield" 20000',
    'try android fill role="textfield" a@b.fr',
  ]);
});

test('android: Auth0 fields missing from the tree are read from the picture, as on the iOS 18 sheet', async () => {
  const f = fake({
    failing: { 'android wait role="textfield" 20000': {}, 'android wait id="username" 8000': {} },
    fields: [{ x: 40, y: 900, w: 1000, h: 120 }],
  });
  const out = await quietly(() => auth0.mobileLogin(f.v, 'android', 'alice'));
  const at = f.calls.indexOf('fields android');
  assert.deepEqual(f.calls.slice(at, at + 6), ['fields android', 'mob android press 540 960', 'sleep 1', 'try android type a@b.fr', 'mob android keyboard return', 'sleep 4']);
  assert.deepEqual(out, ['android: logged in as alice (a@b.fr) — fields read from the capture (Custom Tab not readable)']);
  const none = fake({ failing: { 'android wait role="textfield" 20000': {}, 'android wait id="username" 8000': {} } });
  await assert.rejects(auth0.mobileLogin(none.v, 'android', 'alice'), /die: android: the login form did not show up: no text field in the tree nor on the Custom Tab/);
});

test('a field that does not take the focus is pressed again before typing (TEXT_INPUT_NOT_FOCUSED)', async () => {
  const f = fake({
    failing: {
      'ios wait role="textfield" 20000': {},
      'ios wait id="username" 8000': {},
      'ios type a@b.fr': { times: 1, said: 'Error (TEXT_INPUT_NOT_FOCUSED): No focused text input was available for typing.' },
    },
    fields: [{ x: 20, y: 300, w: 335, h: 45 }],
  });
  await quietly(() => auth0.mobileLogin(f.v, 'ios', 'alice'));
  const at = f.calls.indexOf('try ios type a@b.fr');
  assert.deepEqual(f.calls.slice(at, at + 5), ['try ios type a@b.fr', 'mob ios press 187 322', 'sleep 2', 'mob ios type a@b.fr', 'mob ios keyboard return']);
});

test('fillField: a fill that did not take is pressed and filled again, read back, then cleared and typed', async () => {
  const verify = 'Error (COMMAND_FAILED): Android fill verification failed';
  // Taken on the second fill.
  const twice = fake({ failing: { 'android fill role="textfield" a@b.fr': { times: 1, said: verify } } });
  assert.equal(await fillField(twice.v, 'android', ['role="textfield"'], 'a@b.fr'), '');
  assert.deepEqual(twice.calls, ['try android fill role="textfield" a@b.fr', 'try android press role="textfield"', 'sleep 1', 'try android fill role="textfield" a@b.fr']);
  // Never verified: cleared and typed into.
  const typed = fake({ failing: { 'android fill role="textfield" a@b.fr': { said: verify } } });
  assert.equal(await fillField(typed.v, 'android', ['role="textfield"'], 'a@b.fr'), '');
  assert.deepEqual(typed.calls.slice(-3), ['try android get text role="textfield"', 'try android fill role="textfield" ', 'try android type a@b.fr']);
  // Not on screen by that selector: the next one, with no retry.
  const next = fake({ failing: { 'ios fill role="textfield" a@b.fr': { said: 'Error (COMMAND_FAILED): Selector did not match' } } });
  assert.equal(await fillField(next.v, 'ios', ['role="textfield"', 'id="username"'], 'a@b.fr'), '');
  assert.deepEqual(next.calls, ['try ios fill role="textfield" a@b.fr', 'try ios fill id="username" a@b.fr']);
  // Nothing takes it: agent-device's own words.
  const none = fake({ failing: { 'ios fill id="x" a': { said: 'Error (COMMAND_FAILED): Selector did not match\nHint: …' } } });
  assert.equal(await fillField(none.v, 'ios', ['id="x"'], 'a'), 'Error (COMMAND_FAILED): Selector did not match');
});
