// The connectors' mobile paths, against a fake context: the calls a login makes, in order, which
// a device run cannot pin down call by call. And the bash bridge's own plumbing (cfg, step, die,
// persona_require) on a stub connector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthContext, Box } from '../../src/auth/types.ts';
import type { Platform } from '../../src/core/hold.ts';
import { connector as auth0 } from '../../src/connectors/auth/auth0.ts';
import { connector as form } from '../../src/connectors/auth/form.ts';
import { connector as none } from '../../src/connectors/auth/none.ts';

interface Script {
  failing?: string[]; // mobTry calls (joined) that answer 1
  absent?: string[]; // labels no press / wait finds
  fields?: Box[];
  cfg?: Record<string, string>;
}

function fake(s: Script = {}): { v: AuthContext; calls: string[]; out: string[] } {
  const calls: string[] = [];
  const out: string[] = [];
  const has = (label: string): boolean => !(s.absent ?? []).includes(label);
  const firstOf = (labels: string): string | undefined => labels.split(',').find(has);
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
      return { code: (s.failing ?? []).includes(call) ? 1 : 0, stdout: '', stderr: '' };
    },
    async mobPressIf(p, label) {
      calls.push(`pressIf ${p} ${label}`);
      return has(label);
    },
    async mobPressAny(p, labels) {
      calls.push(`pressAny ${p} ${labels}`);
      return firstOf(labels) !== undefined;
    },
    async mobPressAll(p, labels) {
      calls.push(`pressAll ${p} ${labels}`);
    },
    async mobWaitText(p, text, ms) {
      calls.push(`wait ${p} ${text} ${ms}`);
      return has(text);
    },
    async mobFields(p: Platform) {
      calls.push(`fields ${p}`);
      return s.fields ?? [];
    },
    mobileApp: () => 'Nidz (prep)',
    async mobileLoadBundle(p) {
      calls.push(`bundle ${p}`);
    },
    async mobilePrepare(p) {
      calls.push(`prepare ${p}`);
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
    step: (w) => void calls.push(`step ${w}`),
    async sleep(n) {
      calls.push(`sleep ${n}`);
    },
    lastLine: (t) => t,
    value: (t) => t,
  };
  return { v, calls, out };
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

const OPEN = (p: string): string => `try ${p} open Nidz (prep) --foreground --relaunch --timeout 600000`;
const AFTER = "Entrer directement,Retour à l'accueil";

test('auth0 on android: the door, the Custom Tab, both fields by role', async () => {
  const { v, calls } = fake();
  const out = await capture(() => auth0.mobileLogin(v, 'android', 'alice'));
  assert.deepEqual(calls, [
    'prepare android',
    OPEN('android'),
    'bundle android',
    'pressAny android Autoriser,Allow',
    'pressAny android Close,Fermer',
    'pressAny android Continue,Continuer',
    'wait android Se connecter 8000',
    'pressIf android Se connecter',
    'pressAny android Continuer,Continue',
    'pressAny android Accepter et continuer,Accept & continue',
    'pressAny android Non merci,No thanks',
    'try android wait role="textfield" 20000',
    'try android fill role="textfield" a@b.fr',
    'try android keyboard return',
    'mob android wait text mot de passe 20000',
    'try android fill role="securetextfield" pw',
    'try android keyboard return',
    'sleep 3',
    'pressAny android Plus tard,Not Now',
    'pressAny android Autoriser,Allow',
    'wait android Bienvenue 30000',
    `pressAll android ${AFTER}`,
    'mstate android persona=alice',
  ]);
  assert.deepEqual(out, ['android: logged in as alice (a@b.fr)']);
});

test('auth0 on the iOS 18 sheet: the fields read from the capture', async () => {
  const { v, calls } = fake({
    failing: ['ios wait role="textfield" 20000', 'ios wait id="username" 8000'],
    absent: ['Se connecter'],
    fields: [{ x: 20, y: 300, w: 335, h: 45 }],
  });
  // Not on the door: the logout is tried, then the door has to show.
  await assert.rejects(auth0.mobileLogin(v, 'ios', 'alice'), /die: ios: not on the door screen and no way to log out from here/);
  assert.deepEqual(calls.slice(-4), ['wait ios Se connecter 8000', 'pressIf ios Menu', 'pressIf ios Se déconnecter', 'wait ios Se connecter 15000']);
  const ok = fake({ failing: ['ios wait role="textfield" 20000', 'ios wait id="username" 8000'], fields: [{ x: 20, y: 300, w: 335, h: 45 }] });
  const out = await capture(() => auth0.mobileLogin(ok.v, 'ios', 'alice'));
  const tail = ok.calls.slice(ok.calls.indexOf('try ios wait id="username" 8000') + 1);
  assert.deepEqual(tail, [
    'fields ios',
    'mob ios press 187 322',
    'sleep 1',
    'mob ios type a@b.fr',
    'mob ios keyboard return',
    'sleep 4',
    'fields ios',
    'mob ios press 187 322',
    'sleep 1',
    'mob ios type pw',
    'mob ios keyboard return',
    'sleep 6',
    'pressAny ios Autoriser,Allow',
    'wait ios Bienvenue 30000',
    `pressAll ios ${AFTER}`,
    'mstate ios persona=alice',
  ]);
  assert.deepEqual(out, ['ios: logged in as alice (a@b.fr) — fields read from the capture (iOS 18 sheet not readable)']);
  const none = fake({ failing: ['ios wait role="textfield" 20000', 'ios wait id="username" 8000'] });
  await assert.rejects(auth0.mobileLogin(none.v, 'ios', 'alice'), /die: ios: no text field found on the sheet/);
  const droid = fake({ failing: ['android wait role="textfield" 20000', 'android wait id="username" 8000'] });
  await assert.rejects(auth0.mobileLogin(droid.v, 'android', 'alice'), /die: android: the login form did not show up/);
});

test('auth0: the fallbacks, each tried when the one before fails', async () => {
  const { v, calls } = fake({
    failing: ['ios fill role="textfield" a@b.fr', 'ios fill role="securetextfield" pw', 'ios fill id="password" pw'],
  });
  await capture(() => auth0.mobileLogin(v, 'ios', 'alice'));
  assert.ok(calls.includes('mob ios fill id="username" a@b.fr'));
  assert.ok(calls.includes('mob ios fill label="Mot de passe" pw'));
  const door = fake({ absent: [] });
  door.v.mobPressIf = async (p, label) => (door.calls.push(`pressIf ${p} ${label}`), false);
  await capture(() => auth0.mobileLogin(door.v, 'ios', 'alice'));
  assert.ok(door.calls.includes('mob ios press text="Se connecter" --settle'));
});

test('form on mobile: labels first, then the role; home by the project text', async () => {
  const { v, calls } = fake({ failing: ['ios fill label="E-mail" a@b.fr'], cfg: { MOBILE_READY_TEXT: 'Accueil,Home' }, absent: ['Accueil'] });
  const out = await capture(() => form.mobileLogin(v, 'ios', 'alice'));
  assert.deepEqual(calls, [
    'prepare ios',
    OPEN('ios'),
    'bundle ios',
    'step open Nidz (prep)',
    'pressAny ios Autoriser,Allow',
    'try ios wait role="textfield" 20000',
    'try ios fill label="E-mail" a@b.fr',
    'try ios fill label="Email" a@b.fr',
    'step fill the e-mail field',
    'try ios fill label="Mot de passe" pw',
    'step fill the password field',
    'pressAny ios Se connecter,Connexion,Sign in,Log in,Login,Submit',
    'step submit',
    'wait ios Accueil 20000',
    'wait ios Home 20000',
    'step the app is home',
    'mstate ios persona=alice',
  ]);
  assert.deepEqual(out, ['ios: logged in as alice (a@b.fr)']);
  const lost = fake({ absent: ['Home'], cfg: { FORM_HOME_TEXT: 'Home' } });
  await assert.rejects(form.mobileLogin(lost.v, 'android', 'alice'), /die: android: none of VYSU_FORM_HOME_TEXT showed up after the submit/);
});

test('none on mobile: the app opened, nobody logged in', async () => {
  const { v, calls } = fake();
  const out = await capture(() => none.mobileLogin(v, 'android', 'alice'));
  assert.deepEqual(calls, [OPEN('android'), 'bundle android', 'step open Nidz (prep)', 'mstate android persona=alice']);
  assert.deepEqual(out, ['android: Nidz (prep) opened (this app asks for no login)']);
  const shut = fake({ failing: ['android open Nidz (prep) --foreground --relaunch --timeout 600000'] });
  await assert.rejects(none.mobileLogin(shut.v, 'android', 'alice'), /die: android: cannot open the app \(vysu up android --build\?\)/);
});

test('the bash bridge: cfg, step, die and the credentials of a stub connector', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-bridge-'));
  mkdirSync(join(dir, '.vysu'));
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, '.vysu', 'config'), `VYSU_PROJECT='bridge'\nVYSU_STATE='${join(dir, 'state')}'\nVYSU_ORIGIN='http://o.example'\n`);
  writeFileSync(join(dir, 'state', 'personas.env'), "VYSU_PERSONA_ALICE_EMAIL='alice@example.com'\nVYSU_PERSONA_ALICE_PASSWORD='p a$s\"w'\n", { mode: 0o600 });
  const file = join(dir, '.vysu', 'auth.sh');
  writeFileSync(
    file,
    [
      "auth_describe() { printf 'stub on %s (%s)' \"$(cfg ORIGIN)\" \"$(cfg MISSING fallback)\"; }",
      'auth_web_login() { persona_require "$1"; step "credentials of $1"; [ "$PERSONA_PASSWORD" = \'p a$s"w\' ] || die "wrong password read"; echo "logged in: $1 ($PERSONA_EMAIL) → $2"; }',
      'auth_web_token() { die "no token here" "vysu persona set $1 TOKEN …"; }',
      'auth_mobile_login() { :; }',
    ].join('\n'),
  );
  const { Config } = await import('../../src/core/config.ts');
  const { setConfig } = await import('../../src/core/ctx.ts');
  setConfig(Config.load({ ...process.env, VYSU_OWNER: 'test:1', VYSU_PROJECT_DIR: dir }, dir));
  const { bashConnector } = await import('../../src/auth/bridge.ts');
  const { stepsOn } = await import('../../src/auth/context.ts');
  const c = bashConnector(file);
  assert.equal(await c.describe({} as AuthContext), 'stub on http://o.example (fallback)');
  stepsOn(true);
  // The login writes to this process's own stdout; its exit code is what is checked here.
  await c.webLogin({} as AuthContext, 'alice', 'http://o.example/login');
  await assert.rejects(c.webToken({} as AuthContext, 'alice'), (e: unknown) => (e as { code?: number }).code === 1);
});

// The values in force (a persona's password among them) once went to bash as its `-c` argument, which
// any user of the machine reads in the process list.
test('the bash bridge keeps the values off the command line, in a file only this user reads', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-bridge-'));
  mkdirSync(join(dir, '.vysu'));
  writeFileSync(join(dir, '.vysu', 'config'), `VYSU_PROJECT='bridge'\nVYSU_STATE='${join(dir, 'state')}'\nVYSU_ORIGIN='http://secret.example'\n`);
  const file = join(dir, '.vysu', 'auth.sh');
  writeFileSync(file, 'auth_describe() { printf \'%s\\n%s\\n%s\' "$0" "$(ps -o args= -p $$)" "$(ls -l "$0" | cut -c1-10)"; }\n');
  const { Config } = await import('../../src/core/config.ts');
  const { setConfig } = await import('../../src/core/ctx.ts');
  setConfig(Config.load({ ...process.env, VYSU_OWNER: 'test:1', VYSU_PROJECT_DIR: dir }, dir));
  const { bashConnector } = await import('../../src/auth/bridge.ts');
  const [script, argv, mode] = (await bashConnector(file).describe({} as AuthContext)).split('\n');
  assert.ok(argv!.includes('auth_describe') && !argv!.includes('secret.example'), argv);
  assert.equal(mode, '-rw-------');
  assert.equal(existsSync(script!), false);
});
