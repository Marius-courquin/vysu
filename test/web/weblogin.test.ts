// The auth0 connector's web login against a fake page: the door's button waited for rather than looked
// for once (237 « no sign-in button » of the audit), a door that leads to another followed, a session
// already signed in left as it is, and a failure that says what the page shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthContext } from '../../src/auth/types.ts';
import { clickArgs } from '../../src/auth/context.ts';
import { connector as auth0, pageSays, showsDoor, stillSignedIn } from '../../src/connectors/auth/auth0.ts';

const ORIGIN = 'http://localhost:8100';
const AUTH = 'https://auth.example.com/u/login/identifier?state=x';

interface Page {
  url: string;
  // What one look for these labels finds: the url the click leads to, or nothing.
  doors?: Record<string, string>;
  names?: string[];
}

interface Script {
  start: Record<string, Page>; // what `open <url>` lands on
  pages?: Record<string, Page>; // the pages a click leads to, by url
  holder?: string; // the e-mail of the login the session holds before
  after?: string; // … and after the password (default: the persona's)
  landed?: Page; // where the app comes back after Auth0
  expires?: number; // when the cached token runs out (default: in an hour)
}

function fake(s: Script): { v: AuthContext; calls: string[] } {
  const calls: string[] = [];
  let page: Page = { url: 'about:blank' };
  let holder = s.holder ?? '';
  const go = (url: string): void => {
    page = url.includes('/u/login') ? { url } : (s.pages?.[url] ?? s.start[url] ?? { url });
  };
  const v: AuthContext = {
    async web(_p, ...args) {
      calls.push(`web ${args.join(' ')}`);
      if (args[0] === 'open') page = s.start[args[1]!] ?? { url: args[1]! };
      if (args[0] === 'fill' && args[1] === 'input#password') {
        holder = s.after ?? 'a@b.fr';
        page = s.landed ?? { url: `${ORIGIN}/community/news`, names: ['Menu'] };
      }
      return '';
    },
    async webTry(_p, ...args) {
      if (args[0] === 'get' && args[1] === 'url') return { code: 0, stdout: page.url, stderr: '' };
      const js = args[1] ?? '';
      if (js.includes('decodedToken')) return { code: 0, stdout: JSON.stringify(holder), stderr: '' };
      if (js.includes('expiresAt')) return { code: 0, stdout: JSON.stringify(String(holder ? (s.expires ?? Math.floor(Date.now() / 1000) + 3600) : 0)), stderr: '' };
      if (js.includes('querySelectorAll')) return { code: 0, stdout: JSON.stringify(JSON.stringify({ url: page.url, names: page.names ?? [] })), stderr: '' };
      return { code: 0, stdout: 'true', stderr: '' };
    },
    async webClickAny(_p, ...args) {
      const { names, wait } = clickArgs(args);
      calls.push(`click ${names.join(',')}${wait ? ` wait ${wait}` : ''}`);
      if (names.includes('Continuer')) return true;
      const hit = names.find((n) => page.doors?.[n]);
      if (!hit) return false;
      go(page.doors![hit]!);
      return true;
    },
    mob: async () => '',
    mobTry: async () => ({ code: 0, stdout: '', stderr: '' }),
    mobPressIf: async () => false,
    mobPressAny: async () => false,
    mobPressAll: async () => undefined,
    mobWaitText: async () => false,
    mobFields: async () => [],
    mobileApp: () => '',
    mobileRelaunch: async () => undefined,
    mobileLoadBundle: async () => undefined,
    mobilePrepare: async () => undefined,
    mobileUnblock: async () => '',
    mobileReset: async () => false,
    mstateSet: () => undefined,
    personaRequire: () => ({ email: 'a@b.fr', password: 'pw' }),
    personaVar: () => '',
    cfg: (k, d = '') => ({ AUTH0_DOMAIN: '/u/login', AUTH0_SIGNIN_LABELS: 'Commencer,Se connecter' } as Record<string, string>)[k] ?? d,
    labels: (l) => l.split(',').map((x) => x.trim()).filter(Boolean),
    die(m, next): never {
      throw new Error(`die: ${m}${next ? ` | next: ${next}` : ''}`);
    },
    log: () => undefined,
    step: (w) => void calls.push(`step ${w}`),
    sleep: async () => undefined,
    lastLine: (t) => t,
    value: (t) => {
      try {
        const x: unknown = JSON.parse(t);
        return typeof x === 'string' ? x : t;
      } catch {
        return t;
      }
    },
  };
  return { v, calls };
}

async function capture(fn: () => Promise<void>): Promise<string[]> {
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

const LOGIN = `${ORIGIN}/auth/login`;
const door = (doors: Record<string, string>, url = LOGIN): Page => ({ url, doors, names: [...Object.keys(doors), 'Open TanStack Router Devtools'] });

test('the door is waited for, as long as VYSU_AUTH0_SIGNIN_WAIT, then Auth0', async () => {
  const { v, calls } = fake({ start: { [LOGIN]: door({ 'Se connecter': AUTH }) } });
  const out = await capture(() => auth0.webLogin(v, 'alice', LOGIN));
  assert.equal(calls[2], 'click Commencer,Se connecter wait 15');
  assert.ok(calls.includes('web wait --url **/u/login**'));
  assert.ok(!calls.some((c) => c.startsWith('web wait button')));
  assert.equal(calls.filter((c) => c.startsWith('click Commencer')).length, 1);
  assert.deepEqual(out, [`logged in: alice (a@b.fr) → ${ORIGIN}/community/news`]);
});

test('a door that leads to another: « Commencer » on /, then « Se connecter » on /auth/login', async () => {
  const { v, calls } = fake({
    start: { [`${ORIGIN}/`]: door({ Commencer: LOGIN }, `${ORIGIN}/`) },
    pages: { [LOGIN]: door({ 'Se connecter': AUTH }) },
  });
  await capture(() => auth0.webLogin(v, 'alice', `${ORIGIN}/`));
  assert.deepEqual(
    calls.filter((c) => c.startsWith('step')),
    ['step open http://localhost:8100/', 'step click the sign-in button', 'step click the next sign-in button', 'step reach /u/login', 'step fill the e-mail field', 'step fill the password field', 'step land back on http://localhost:8100'],
  );
});

test('no door: the failure says where the page is and what it offers', async () => {
  const { v } = fake({ start: { [LOGIN]: { url: LOGIN, names: ['Retour à l\'accueil', 'Open Tanstack query devtools'] } } });
  await assert.rejects(
    () => auth0.webLogin(v, 'alice', LOGIN),
    /no sign-in button on http:\/\/localhost:8100\/auth\/login after 15s: the page is http:\/\/localhost:8100\/auth\/login, its buttons and links: « Retour à l'accueil », « Open Tanstack query devtools » \(VYSU_AUTH0_SIGNIN_LABELS, VYSU_AUTH0_SIGNIN_WAIT\)/,
  );
});

test('already signed in as the persona: the app shows its home, nothing is done', async () => {
  const home = { url: `${ORIGIN}/community/news`, names: ['Menu'] };
  const { v, calls } = fake({ start: { [LOGIN]: home }, holder: 'A@b.fr' });
  const out = await capture(() => auth0.webLogin(v, 'alice', LOGIN));
  assert.equal(calls[2], 'click Commencer,Se connecter wait 4');
  assert.ok(!calls.some((c) => c.includes('--url')));
  assert.deepEqual(out, [`logged in: alice (a@b.fr) → ${ORIGIN}/community/news (already signed in: nothing done)`]);
});

test('a login that has expired: the door shows after the short look, the rest of the wait is spent on it', async () => {
  let looks = 0;
  const { v, calls } = fake({ start: { [LOGIN]: door({ 'Se connecter': AUTH }) }, holder: 'a@b.fr' });
  const click = v.webClickAny;
  v.webClickAny = async (p, ...args) => (++looks === 1 ? (calls.push('click (loader)'), false) : click(p, ...args));
  await capture(() => auth0.webLogin(v, 'alice', LOGIN));
  assert.ok(calls.includes('click Commencer,Se connecter wait 11'));
  assert.ok(calls.includes('web wait --url **/u/login**'));
});

test('a login held but expired, or a page that is a door after all: not « already signed in »', async () => {
  // The identity is still cached, the token ran out an hour ago: the rest of the wait goes to the door.
  const home = { url: `${ORIGIN}/community/news`, names: ['Menu'] };
  const { v, calls } = fake({ start: { [LOGIN]: home }, holder: 'a@b.fr', expires: Math.floor(Date.now() / 1000) - 3600 });
  await assert.rejects(() => auth0.webLogin(v, 'alice', LOGIN), /no sign-in button/);
  assert.ok(calls.includes('click Commencer,Se connecter wait 11'), calls.join('\n'));
  assert.equal(stillSignedIn(2000, 1000, false), true);
  assert.equal(stillSignedIn(1010, 1000, false), false);
  assert.equal(stillSignedIn(0, 1000, false), false);
  assert.equal(stillSignedIn(5000, 1000, true), false);
});

test('signed in as someone else: said, with the way to a clean session', async () => {
  const { v } = fake({ start: { [LOGIN]: { url: `${ORIGIN}/community/news` } }, holder: 'bob@b.fr' });
  await assert.rejects(() => auth0.webLogin(v, 'alice', LOGIN), /signed in as bob@b\.fr, not a@b\.fr .*next: vysu alice close/);
});

test('Auth0 took the password but the app came back to its door with no login: a failure, not « logged in »', async () => {
  const { v } = fake({ start: { [LOGIN]: door({ 'Se connecter': AUTH }) }, after: '', landed: door({ 'Se connecter': AUTH }) });
  await assert.rejects(() => auth0.webLogin(v, 'alice', LOGIN), /back on its door with no login/);
});

test('pageSays and showsDoor', () => {
  const many = JSON.stringify({ url: 'u', names: Array.from({ length: 11 }, (_, i) => `b${i}`) });
  assert.match(pageSays(many), /« b7 » and 3 more$/);
  assert.equal(pageSays(JSON.stringify({ url: 'u', names: [] })), 'the page is u, with no button nor link (still loading?)');
  assert.equal(pageSays('nope'), 'the page could not be read');
  assert.equal(showsDoor(JSON.stringify({ names: ['SE CONNECTER'] }), ['Se connecter']), true);
  assert.equal(showsDoor(JSON.stringify({ names: ['Se connecter avec Google'] }), ['Se connecter']), false);
});

test('webClickAny: the options ride as a last argument', () => {
  assert.deepEqual(clickArgs(['a', 'b']), { names: ['a', 'b'], wait: 0 });
  assert.deepEqual(clickArgs(['a', { wait: 15 }]), { names: ['a'], wait: 15 });
  assert.deepEqual(clickArgs([{ wait: -3 }]), { names: [], wait: 0 });
});
