// The token connector against a fake context: what it writes where, what it refuses before a browser
// is touched, and what it reads back. And its pure parts: the store spec, a JWT's expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthContext } from '../../src/auth/types.ts';
import { connector as token, expiryWords, jwtExpiry, parseStore } from '../../src/connectors/auth/token.ts';

const jwt = (claims: Record<string, unknown>): string =>
  ['{"alg":"none"}', JSON.stringify(claims), ''].map((p) => Buffer.from(p).toString('base64url')).join('.') + 'sig';

interface Page {
  cfg?: Record<string, string>;
  vars?: Record<string, string>;
  // What the page answers to the read-back eval / `cookies get`.
  held?: string;
  cookies?: Array<{ name: string; value: string }>;
}

function fake(p: Page = {}): { v: AuthContext; calls: string[] } {
  const calls: string[] = [];
  const answer = (args: string[]): string => {
    if (args[0] === 'eval' && args[1]!.includes("'set'")) return '"set"';
    if (args[0] === 'eval') return JSON.stringify(p.held ?? '');
    if (args[0] === 'cookies' && args[1] === 'get') return JSON.stringify({ data: { cookies: p.cookies ?? [] } });
    if (args[0] === 'get' && args[1] === 'url') return 'https://app.example.com/home';
    return '';
  };
  const v = {
    async web(_persona: string, ...args: string[]) {
      calls.push(`web ${args.join(' ')}`);
      return answer(args);
    },
    async webTry(_persona: string, ...args: string[]) {
      calls.push(`try ${args.join(' ')}`);
      return { code: 0, stdout: answer(args), stderr: '' };
    },
    personaVar: (_persona: string, key: string) => p.vars?.[key] ?? '',
    cfg: (k: string, d = '') => p.cfg?.[k] ?? d,
    die(m: string, next?: string): never {
      throw new Error(`die: ${m}${next ? ` | next: ${next}` : ''}`);
    },
    step: (w: string) => void calls.push(`step ${w}`),
    lastLine: (t: string) => t,
    value: (t: string) => {
      try {
        const x: unknown = JSON.parse(t);
        return typeof x === 'string' ? x : t;
      } catch {
        return t;
      }
    },
  } as unknown as AuthContext;
  return { v, calls };
}

test('store spec: localStorage or cookie, with a name', () => {
  assert.deepEqual(parseStore('localStorage:accessToken'), { kind: 'localStorage', name: 'accessToken' });
  assert.deepEqual(parseStore('cookie:session'), { kind: 'cookie', name: 'session' });
  for (const bad of ['localStorage', 'localStorage:', 'sessionStorage:x', 'header:Authorization']) {
    assert.match(String(parseStore(bad)), /VYSU_TOKEN_STORE is localStorage:<key> or cookie:<name>/);
  }
});

test("a JWT's expiry, and nothing for an opaque token", () => {
  assert.equal(jwtExpiry(jwt({ exp: 1_900_000_000 })), 1_900_000_000);
  assert.equal(jwtExpiry(jwt({ sub: 'x' })), 0);
  assert.equal(jwtExpiry('opaque-token'), 0);
  assert.equal(jwtExpiry('a.b.c'), 0);
  assert.equal(expiryWords(1000, 1000 - 40 * 60), 'valid 40 min more');
  assert.equal(expiryWords(1000, 1000 + 3 * 3600), 'expired 3 h ago');
  assert.equal(expiryWords(1000, 1000 - 30), 'valid 30 s more');
});

test('localStorage: opened, written, opened again for the app to boot on it, then read back', async () => {
  const t = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const { v, calls } = fake({ cfg: { TOKEN_STORE: 'localStorage:accessToken' }, vars: { TOKEN: t, EMAIL: 'c@x.fr' }, held: t });
  const out: string[] = [];
  const log = console.log;
  console.log = (s: string) => void out.push(s);
  try {
    await token.webLogin(v, 'charles@2', 'https://app.example.com/#/map');
  } finally {
    console.log = log;
  }
  const web = calls.filter((c) => !c.startsWith('step'));
  assert.equal(web[0], 'web open https://app.example.com/#/map');
  assert.match(web[1]!, /^web eval \(\(\) => \{ localStorage\.setItem\("accessToken", "ey/);
  assert.equal(web[2], 'web open https://app.example.com/#/map');
  assert.ok(web.includes(`try eval localStorage.getItem("accessToken") || ''`));
  // The token is in the page's script, never in a line vysu prints.
  assert.match(out[0]!, /^logged in: charles@2 \(c@x\.fr\) by token, valid (59|60) min more → https:\/\/app\.example\.com\/home$/);
  assert.ok(!out.join('\n').includes(t));
});

test('cookie: set on the origin before the first load', async () => {
  const { v, calls } = fake({ cfg: { TOKEN_STORE: 'cookie:sid' }, vars: { TOKEN: 'opaque' }, cookies: [{ name: 'sid', value: 'opaque' }] });
  const log = console.log;
  console.log = () => undefined;
  try {
    await token.webLogin(v, 'charles', 'https://app.example.com/login');
  } finally {
    console.log = log;
  }
  assert.deepEqual(calls.slice(0, 2), ['web cookies set sid opaque --url https://app.example.com', 'step cookie sid set on https://app.example.com']);
  assert.equal(await token.webToken(v, 'charles'), 'opaque');
});

test('refused before any browser call: no token, an expired JWT; after: a token the app dropped', async () => {
  let f = fake({});
  await assert.rejects(token.webLogin(f.v, 'charles', 'https://a.example'), /holds no token \| next: vysu persona set charles TOKEN/);
  assert.deepEqual(f.calls, []);
  f = fake({ vars: { TOKEN: jwt({ exp: Math.floor(Date.now() / 1000) - 7200 }) } });
  await assert.rejects(token.webLogin(f.v, 'charles@3', 'https://a.example'), /the token of 'charles' expired 2 h ago/);
  assert.deepEqual(f.calls, []);
  f = fake({ vars: { TOKEN: 'opaque' }, held: '' });
  await assert.rejects(token.webLogin(f.v, 'charles', 'https://a.example'), /the app dropped the token of 'charles' on boot/);
});

test('a shape of the app own: WRITE_JS with `token` in scope, READ_JS to read it back', async () => {
  const { v, calls } = fake({
    cfg: { TOKEN_WRITE_JS: 'localStorage.setItem("auth", JSON.stringify({ token }))', TOKEN_READ_JS: 'JSON.parse(localStorage.getItem("auth")).token' },
    vars: { TOKEN: 'opaque' },
    held: 'opaque',
  });
  const log = console.log;
  console.log = () => undefined;
  try {
    await token.webLogin(v, 'charles', 'https://a.example/');
  } finally {
    console.log = log;
  }
  assert.ok(calls.includes('web eval (() => { const token = "opaque"; localStorage.setItem("auth", JSON.stringify({ token })); return \'set\'; })()'));
  assert.ok(calls.includes('try eval JSON.parse(localStorage.getItem("auth")).token'));
});

test('mobile: said to be web only', async () => {
  const { v } = fake({});
  await assert.rejects(token.mobileLogin(v, 'ios', 'charles'), /the token connector is web only/);
});
