// The commands that go through the auth connector: `login`, `mlogin`, `auth token`, `auth test`.
import { rmSync } from 'node:fs';
import { config } from '../core/ctx.ts';
import { die, onCleanup } from '../core/errors.ts';
import { lockTake, platformLock, type Platform } from '../core/hold.ts';
import { personaRequire } from '../core/personas.ts';
import { mobileSessionOpen, mstateGet } from '../mobile/api.ts';
import { abRaw, expectFreshSession, lastLine, restoreFile, sessionRunning, setAuthTestSession, webLockOf } from '../web/ab.ts';
import { sleep } from '../core/text.ts';
import { context, stepsOn } from './context.ts';
import { authLoad } from './load.ts';

export async function login(persona: string, url: string): Promise<void> {
  // A login is what a new session is waiting for: nothing to say about it being new.
  expectFreshSession();
  if (!url) url = config().need('ORIGIN', "the app's web origin").replace(/\/$/, '') + config().get('LOGIN_PATH');
  const a = await authLoad();
  await a.connector.webLogin(context(), persona, url);
}

// A login costs one to three minutes (the identity provider's pages typed into a system web view),
// and checkers asked, again and again, for the persona their device already held: when vysu's record
// says it is that persona and the app, as it stands, shows someone signed in, there is nothing to do.
// The record alone is not enough (the app's data cleared, a logout by hand); --force logs in anyway.
// The device is locked before the record is read: another agent's login waited out behind the lock
// would otherwise answer the look at the screen, for a record read before it began.
export async function mlogin(platform: string, persona: string, force = false): Promise<void> {
  const a = await authLoad();
  const p = platform as Platform;
  const { email } = personaRequire(persona);
  const signedIn = a.connector.mobileSignedIn;
  if (!force && signedIn) await platformLock(p);
  if (!force && signedIn && mstateGet(p, 'persona') === persona && (await mobileSessionOpen(p)) && (await signedIn(context(), p))) {
    console.log(`${p}: already logged in as ${persona} (${email}), left as it is (--force logs in again)`);
    return;
  }
  await a.connector.mobileLogin(context(), p, persona);
}

// The API access token of a persona's session, or '' (undefined: the connector has none to give).
export async function token(persona: string): Promise<string | undefined> {
  const a = await authLoad();
  return a.connector.webToken(context(), persona);
}

// The web test runs on a session of its own — its own profile, no cookie of the persona's real
// session — so a connector is exercised the way a first login sees it, and the real session is
// neither consumed nor left half logged in. The session is closed whichever way this ends.
async function closeTestSession(session: string): Promise<void> {
  setAuthTestSession('');
  await abRaw(['--session', session, 'close'], { stderr: 'drop' });
  // The restore file is what would carry a login into the next test: it goes with the session.
  rmSync(restoreFile(session), { force: true });
}

export async function test(persona: string, platform: string): Promise<void> {
  const a = await authLoad();
  const v = context();
  stepsOn(true);
  console.log(`auth test: ${a.name} — ${await a.connector.describe(v)}`);
  if (platform) {
    if (platform !== 'ios' && platform !== 'android') die('vysu auth test: the platform is ios or android');
    // One install is one session: there is no throwaway device, and the test logs the persona in
    // for real — which also rotates whatever the identity provider rotates on a login.
    console.log(`device: the real ${platform} app (one install = one session): this logs ${persona} in for good`);
    await a.connector.mobileLogin(v, platform, persona);
    v.step(`mobile login as ${persona}`);
    console.log('auth test: ok');
    return;
  }
  const origin = config().need('ORIGIN', "the app's web origin");
  const url = origin.replace(/\/$/, '') + config().get('LOGIN_PATH');
  const session = `${config().get('PROJECT')}-authtest`;
  setAuthTestSession(session);
  // One test session for the project: held before anything below drops its restore file or closes it,
  // or a second agent's test would end the first one's login half way. Its closing is registered only
  // once it is this test's to close.
  await lockTake(webLockOf(persona));
  const disarm = onCleanup(() => closeTestSession(session));
  // A throwaway session that a killed run left behind still holds its restore file: drop it before
  // the test rather than after, so « no cookies » is true even then.
  rmSync(restoreFile(session), { force: true });
  // Only when one is actually running: closing a session that is not there starts a daemon just to
  // stop it, and that shutdown lands on the browser the test opens a second later — the page comes
  // back blank half way through the login, which is a long way from where the real fault is.
  // And once closed, gone from the list before the test opens its own: the shutdown of the one a
  // killed run left behind landed on the fresh browser too (the login page came back about:blank).
  if (await sessionRunning(persona)) {
    await abRaw(['--session', session, 'close'], { stderr: 'drop' });
    for (let i = 0; i < 20 && (await sessionRunning(persona)); i++) await sleep(150);
  }
  console.log(`session: ${session} (throwaway, no cookies)`);
  await a.connector.webLogin(v, persona, url);
  v.step(`web login as ${persona}`);
  const landed = lastLine((await v.webTry(persona, 'get', 'url')).stdout);
  console.log(`url: ${landed || '(unknown)'}`);
  let tok: string | undefined;
  try {
    tok = await a.connector.webToken(v, persona);
  } catch {
    tok = '';
  }
  if (tok) {
    // Never the token itself: what a test has to prove is that the connector can find one.
    v.step(`auth token (${tok.length} characters)`);
  } else {
    console.log('token: none (this connector exposes none)');
  }
  disarm();
  await closeTestSession(session);
  console.log('auth test: ok');
}
