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
import { buttonsLabelled, connector as auth0 } from '../../src/connectors/auth/auth0.ts';
import { connector as form } from '../../src/connectors/auth/form.ts';
import { connector as none } from '../../src/connectors/auth/none.ts';

interface Script {
  failing?: string[]; // mobTry calls (joined) that answer 1
  absent?: string[]; // labels no press / wait finds
  fields?: Box[];
  cfg?: Record<string, string>;
  refuse?: boolean; // mobileRelaunch dies: the app cannot start
  anr?: string; // mobileUnblock answers an ANR dialog of that package, once
  reset?: boolean; // mobileReset clears the app data (Android)
  said?: Record<string, string>; // what a failing mobTry call prints
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
      const failing = (s.failing ?? []).includes(call);
      return { code: failing ? 1 : 0, stdout: '', stderr: failing ? (s.said?.[call] ?? '') : '' };
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
    async mobileRelaunch(p) {
      calls.push(`relaunch ${p}`);
      if (s.refuse) throw new Error(`die: ${p}: fr.nidz did not start on the device (not installed?)`);
    },
    async mobileLoadBundle(p) {
      calls.push(`bundle ${p}`);
    },
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

const AFTER = "Entrer directement,Retour à l'accueil";

test('auth0 on android: the door, the Custom Tab, both fields by role', async () => {
  const { v, calls } = fake();
  const out = await capture(() => auth0.mobileLogin(v, 'android', 'alice'));
  assert.deepEqual(calls, [
    'prepare android',
    'relaunch android',
    'pressAny android Autoriser,Allow',
    'wait android Se connecter 4000',
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
  // Not on the door, someone signed in (« Menu » shows), and the logout never reaches the door: tried
  // here, then once more from a cold start; iOS has no data to clear after that.
  await assert.rejects(auth0.mobileLogin(v, 'ios', 'alice'), /die: ios: not on the door screen and no way to log out from here/);
  const once = [
    'pressIf ios Menu',
    'wait ios Se déconnecter 5000',
    'try ios snapshot -i --json',
    'pressIf ios Se déconnecter',
    'wait ios Se connecter 6000',
    'try ios snapshot -i --json',
    'wait ios Se connecter 15000',
  ];
  assert.deepEqual(calls.slice(calls.indexOf('wait ios Se connecter 4000')), ['wait ios Se connecter 4000', 'wait ios Menu 1500', ...once, 'relaunch ios', ...once, 'reset ios']);
  const ok = fake({ failing: ['ios wait role="textfield" 20000', 'ios wait id="username" 8000'], fields: [{ x: 20, y: 300, w: 335, h: 45 }] });
  const out = await capture(() => auth0.mobileLogin(ok.v, 'ios', 'alice'));
  const tail = ok.calls.slice(ok.calls.indexOf('try ios wait id="username" 8000') + 1);
  assert.deepEqual(tail, [
    'unblock ios',
    'fields ios',
    'mob ios press 187 322',
    'sleep 1',
    'try ios type a@b.fr',
    'mob ios keyboard return',
    'sleep 4',
    'fields ios',
    'mob ios press 187 322',
    'sleep 1',
    'try ios type pw',
    'mob ios keyboard return',
    'sleep 6',
    'pressAny ios Autoriser,Allow',
    'wait ios Bienvenue 30000',
    `pressAll ios ${AFTER}`,
    'mstate ios persona=alice',
  ]);
  assert.deepEqual(out, ['ios: logged in as alice (a@b.fr) — fields read from the capture (sheet not readable)']);
  const none = fake({ failing: ['ios wait role="textfield" 20000', 'ios wait id="username" 8000'] });
  await assert.rejects(auth0.mobileLogin(none.v, 'ios', 'alice'), /die: ios: the login form did not show up: no text field in the tree nor on the sheet/);
  const droid = fake({ failing: ['android wait role="textfield" 20000', 'android wait id="username" 8000'] });
  await assert.rejects(auth0.mobileLogin(droid.v, 'android', 'alice'), /die: android: the login form did not show up/);
});

test('auth0: the fallbacks, each tried when the one before fails', async () => {
  const { v, calls } = fake({
    failing: ['ios fill role="textfield" a@b.fr', 'ios fill role="securetextfield" pw', 'ios fill id="password" pw'],
  });
  await capture(() => auth0.mobileLogin(v, 'ios', 'alice'));
  assert.ok(calls.includes('try ios fill id="username" a@b.fr'));
  assert.ok(calls.includes('try ios fill label="Mot de passe" pw'));
  // Nothing takes the text: the login ends there, saying which field.
  const stuck = fake({ failing: ['ios fill role="textfield" a@b.fr', 'ios fill id="username" a@b.fr'], said: { 'ios fill id="username" a@b.fr': 'Error (SELECTOR_NOT_FOUND): no match' } });
  await assert.rejects(auth0.mobileLogin(stuck.v, 'ios', 'alice'), /die: ios: the e-mail field could not be filled: Error \(SELECTOR_NOT_FOUND\): no match/);
  const door = fake({ absent: [] });
  door.v.mobPressIf = async (p, label) => (door.calls.push(`pressIf ${p} ${label}`), false);
  await capture(() => auth0.mobileLogin(door.v, 'ios', 'alice'));
  assert.ok(door.calls.includes('mob ios press text="Se connecter" --settle'));
});

// The logout against a screen that changes: what is on it, and what a press or a relaunch puts there
// instead. A `dialog:<label>` is a dialog's button of that label, listed with the others by a
// snapshot, in a box of its own, and pressed by its ref.
function screens(start: string[], moves: Record<string, string[]>, root: string[], cfg: Record<string, string> = {}): { v: AuthContext; calls: string[] } {
  const f = fake({ cfg });
  let on = new Set(start);
  const shown = (): string[] => [...on];
  f.v.mobPressIf = async (p, label) => {
    f.calls.push(`pressIf ${p} ${label}`);
    if (!on.has(label)) return false;
    if (moves[label]) on = new Set(moves[label]);
    return true;
  };
  f.v.mobWaitText = async (p, text, ms) => (f.calls.push(`wait ${p} ${text} ${ms}`), on.has(text));
  f.v.mobTry = async (p, ...args) => {
    f.calls.push(`try ${p} ${args.join(' ')}`);
    if (args[0] === 'snapshot') {
      // iOS lists a dialog's window first: the dialog's button comes before the screen's own.
      const nodes = shown()
        .sort((a, b) => Number(b.startsWith('dialog:')) - Number(a.startsWith('dialog:')))
        .map((l, i) => ({ ref: `e${i + 1}`, type: 'Button', label: l.replace(/^dialog:/, ''), rect: { x: 0, y: l.startsWith('dialog:') ? 370 : 35 } }));
      return { code: 0, stdout: JSON.stringify({ success: true, data: { nodes } }), stderr: '' };
    }
    if (args[0] === 'press') {
      const i = Number((args[1] ?? '').replace('@e', '')) - 1;
      const label = shown().sort((a, b) => Number(b.startsWith('dialog:')) - Number(a.startsWith('dialog:')))[i];
      if (label && moves[label]) on = new Set(moves[label]);
      return { code: label ? 0 : 1, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  f.v.mobileRelaunch = async (p) => {
    f.calls.push(`relaunch ${p}`);
    on = new Set(root);
  };
  return f;
}
const DOOR = ['Se connecter'];

test('auth0 logout from the tabs: the menu, its row once it shows, then the door', async () => {
  // Android keeps the drawer's rows in the tree while it is closed: the row is there from the start,
  // and still only pressed once the menu is open.
  const { v, calls } = screens(['Menu', 'Se déconnecter'], { Menu: ['Menu', 'Se déconnecter', 'Mon profil'], 'Se déconnecter': DOOR }, []);
  assert.equal(await auth0.mobileLogout!(v, 'android'), true);
  assert.deepEqual(calls, [
    'pressIf android Menu',
    'wait android Se déconnecter 5000',
    'try android snapshot -i --json',
    'pressIf android Se déconnecter',
    'wait android Se connecter 6000',
  ]);
});

test('auth0 logout on a screen with no menu: its own button, then the dialog\'s, the one that was not there', async () => {
  // The gate's « SE DÉCONNECTER » and, once pressed, the dialog's « Se déconnecter » over it: the same
  // label, both hittable, the dialog's listed first on iOS.
  const { v, calls } = screens(['Se déconnecter'], { 'Se déconnecter': ['Se déconnecter', 'dialog:Se déconnecter'], 'dialog:Se déconnecter': DOOR }, []);
  assert.equal(await auth0.mobileLogout!(v, 'ios'), true);
  assert.deepEqual(calls, [
    'pressIf ios Menu',
    'try ios snapshot -i --json',
    'pressIf ios Se déconnecter',
    'wait ios Se connecter 6000',
    'try ios snapshot -i --json',
    'try ios press @e1 --settle',
    'wait ios Se connecter 15000',
  ]);
  // A dialog that confirms in its own words.
  const oui = screens(['Se déconnecter'], { 'Se déconnecter': ['Se déconnecter', 'dialog:Oui'], 'dialog:Oui': DOOR }, [], { AUTH0_LOGOUT_CONFIRM_LABELS: 'Confirmer,Oui' });
  assert.equal(await auth0.mobileLogout!(oui.v, 'ios'), true);
  assert.ok(oui.calls.includes('try ios press @e1 --settle'), oui.calls.join('\n'));
});

test('buttonsLabelled: buttons only, by label whatever the case, with their ref and box', () => {
  const snap = JSON.stringify({
    success: true,
    data: {
      nodes: [
        { ref: 'e1', type: 'Other', label: 'SE DÉCONNECTER', rect: { x: 0, y: 0 } },
        { ref: 'e11', type: 'Button', label: 'Se déconnecter', rect: { x: 52.5, y: 369.5 } },
        { ref: 'e15', type: 'Button', label: 'SE DÉCONNECTER', rect: { x: 17.5, y: 35 } },
        { ref: 'e16', type: 'android.widget.Button', label: 'Oui', rect: { x: 1, y: 2 } },
        { ref: 'e17', type: 'Button', label: 'Annuler' },
      ],
    },
  });
  assert.deepEqual(buttonsLabelled(snap, ['Se déconnecter']), [
    { ref: 'e11', box: '{"x":52.5,"y":369.5}' },
    { ref: 'e15', box: '{"x":17.5,"y":35}' },
  ]);
  assert.deepEqual(buttonsLabelled(snap, ['Oui']), [{ ref: 'e16', box: '{"x":1,"y":2}' }]);
  assert.deepEqual(buttonsLabelled('', ['Oui']), []);
  assert.deepEqual(buttonsLabelled('{"success":false}', ['Oui']), []);
});

test('auth0 logout from a pushed screen or a viewer over the menu: once more from a cold start', async () => {
  // An image viewer: its « Close » and pages, nothing of the tab bar that can be pressed.
  const { v, calls } = screens(['Close', 'page 1 sur 2'], { Menu: ['Menu', 'Se déconnecter'], 'Se déconnecter': DOOR }, ['Menu']);
  assert.equal(await auth0.mobileLogout!(v, 'ios'), true);
  assert.deepEqual(calls, [
    'pressIf ios Menu',
    'try ios snapshot -i --json',
    'pressIf ios Se déconnecter',
    'relaunch ios',
    'pressIf ios Menu',
    'wait ios Se déconnecter 5000',
    'try ios snapshot -i --json',
    'pressIf ios Se déconnecter',
    'wait ios Se connecter 6000',
  ]);
  // A menu that opens on nothing (covered, or another app's): the row never shows, same way out.
  const covered = screens(['Menu'], {}, ['Menu']);
  assert.equal(await auth0.mobileLogout!(covered.v, 'android'), false);
  assert.deepEqual(covered.calls, ['pressIf android Menu', 'wait android Se déconnecter 5000', 'relaunch android', 'pressIf android Menu', 'wait android Se déconnecter 5000']);
});

test('auth0 mlogin over another persona: relaunched, logged out through the menu, then the door', async () => {
  const f = screens(['Menu', 'Bienvenue'], { Menu: ['Menu', 'Se déconnecter'], 'Se déconnecter': DOOR }, ['Menu', 'Bienvenue']);
  const snapshotted = f.v.mobTry;
  f.v.mobTry = async (p, ...args) => (args[0] === 'snapshot' ? snapshotted(p, ...args) : (f.calls.push(`try ${p} ${args.join(' ')}`), { code: 0, stdout: '', stderr: '' }));
  await capture(() => auth0.mobileLogin(f.v, 'android', 'alice'));
  assert.deepEqual(f.calls.slice(0, 10), [
    'prepare android',
    'relaunch android',
    'pressAny android Autoriser,Allow',
    'wait android Se connecter 4000',
    'wait android Menu 1500',
    'pressIf android Menu',
    'wait android Se déconnecter 5000',
    'try android snapshot -i --json',
    'pressIf android Se déconnecter',
    'wait android Se connecter 6000',
  ]);
  assert.ok(f.calls.includes('mstate android persona=alice'));
  // Nothing pressed blind for Expo's dev menu: « Fermer » is also the app's own drawer backdrop.
  assert.ok(!f.calls.some((c) => /Close|Fermer|Continue,Continuer/.test(c)), f.calls.join('\n'));
});

test('form on mobile: labels first, then the role; home by the project text', async () => {
  const { v, calls } = fake({ failing: ['ios fill label="E-mail" a@b.fr'], cfg: { MOBILE_READY_TEXT: 'Accueil,Home' }, absent: ['Accueil'] });
  const out = await capture(() => form.mobileLogin(v, 'ios', 'alice'));
  assert.deepEqual(calls, [
    'prepare ios',
    'relaunch ios',
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
  assert.deepEqual(calls, ['relaunch android', 'step open Nidz (prep)', 'mstate android persona=alice']);
  assert.deepEqual(out, ['android: Nidz (prep) opened (this app asks for no login)']);
  const shut = fake({ refuse: true });
  await assert.rejects(none.mobileLogin(shut.v, 'android', 'alice'), /die: android: fr.nidz did not start on the device/);
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
