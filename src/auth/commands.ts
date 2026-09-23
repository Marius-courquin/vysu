// The commands that go through the auth connector: `login`, `mlogin`, `auth token`, `auth test`.
import { rmSync } from 'node:fs';
import { config } from '../core/ctx.ts';
import { die, onCleanup } from '../core/errors.ts';
import type { Platform } from '../core/hold.ts';
import { abRaw, lastLine, restoreFile, sessionRunning, setAuthTestSession } from '../web/ab.ts';
import { sleep } from '../core/text.ts';
import { context, stepsOn } from './context.ts';
import { authLoad } from './load.ts';

export async function login(persona: string, url: string): Promise<void> {
  if (!url) url = config().need('ORIGIN', "the app's web origin").replace(/\/$/, '') + config().get('LOGIN_PATH');
  const a = await authLoad();
  await a.connector.webLogin(context(), persona, url);
}

export async function mlogin(platform: string, persona: string): Promise<void> {
  const a = await authLoad();
  await a.connector.mobileLogin(context(), platform as Platform, persona);
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
