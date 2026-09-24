// auth0 — Auth0 Universal Login, identifier-first: e-mail on one page, password on the next, each
// carrying two submit buttons (one hidden) so the visible one is found by role and name. The token
// is read out of the auth0-spa-js cache in localStorage. On mobile the login runs in a system web
// surface (SafariViewService / Chrome Custom Tab), behind a handful of OS dialogs.
//
// Options (defaults in brackets):
//   VYSU_AUTH0_DOMAIN             [auth0.com]                     what an Auth0 url looks like
//   VYSU_AUTH0_SIGNIN_LABELS      [Se connecter,Sign in]          the door's button, web and mobile
//   VYSU_AUTH0_CONTINUE_LABELS    [Continuer,Continue]            Universal Login's submit
//   VYSU_AUTH0_DOOR_TEXT          [Se connecter]                  the mobile door screen's text
//   VYSU_AUTH0_HOME_TEXT          [Bienvenue]                     the text that proves the login
//   VYSU_AUTH0_PASSWORD_TEXT      [mot de passe]                  the password page's own text
//   VYSU_AUTH0_MENU_LABEL         [Menu]                          mobile: the control that opens the menu holding the logout
//   VYSU_AUTH0_LOGOUT_LABEL       [Se déconnecter]                mobile: logging another persona out
//   VYSU_AUTH0_LOGOUT_CONFIRM_LABELS [the logout label]           mobile: the button of a dialog confirming the logout
//   VYSU_AUTH0_AFTER_LOGIN_LABELS [Entrer directement,Retour à l'accueil]   buttons pressed if they show up
import type { AuthConnector, AuthContext } from '../../auth/types.ts';
import { exit } from '../../core/errors.ts';
import type { Platform } from '../../core/hold.ts';

const opt = (v: AuthContext, key: string, def: string): string => v.cfg(`AUTH0_${key}`, def);
const domain = (v: AuthContext): string => opt(v, 'DOMAIN', 'auth0.com');

// auth0-spa-js keeps its cache in localStorage (cacheLocation="localstorage" in the app).
const TOKEN_JS =
  "(() => { for (const k of Object.keys(localStorage)) { if (!k.startsWith('@@auth0spajs@@') || k.endsWith('@@user@@')) continue; const t = JSON.parse(localStorage.getItem(k) || '{}'); if (t.body && t.body.access_token) return t.body.access_token; } return ''; })()";

// The centre of the first text field on screen, in points, for the surfaces the platform's
// accessibility cannot read: the picture is all there is to go by there.
async function firstField(v: AuthContext, platform: Platform): Promise<[string, string] | null> {
  const box = (await v.mobFields(platform))[0];
  if (!box) return null;
  return [String(Math.floor(box.x + Math.floor(box.w / 2))), String(Math.floor(box.y + Math.floor(box.h / 2)))];
}

// The buttons on screen that carry one of these labels (as the selectors read them, whatever the case:
// Nidz's gate screens draw « SE DÉCONNECTER »), each by its ref in this snapshot and its box.
export function buttonsLabelled(snapshotJson: string, labels: string[]): Array<{ ref: string; box: string }> {
  let nodes: Array<{ ref?: string; type?: string; label?: string; rect?: unknown }> = [];
  try {
    const d = JSON.parse(snapshotJson) as { data?: { nodes?: typeof nodes } };
    nodes = d.data?.nodes ?? [];
  } catch {
    return [];
  }
  const want = labels.map((l) => l.toLocaleLowerCase('fr'));
  return nodes
    .filter((n) => /button/i.test((n.type ?? '').split('.').pop() ?? '') && want.includes((n.label ?? '').toLocaleLowerCase('fr')) && n.ref)
    .map((n) => ({ ref: n.ref!, box: JSON.stringify(n.rect ?? null) }));
}

// One try at the logout from the screen the app is on. The app's way out sits behind its menu (Nidz V2:
// the avatar button « Menu » of the tab bar, then the drawer's « Se déconnecter », no dialog) or, on a
// screen with no menu (an access request, an address to verify), on the screen itself, often behind a
// dialog that confirms it with a button of the same label. The menu is opened first whenever there is
// one: on Android the drawer's rows stay in the tree while it is closed (a 1 px sliver at x=0 that
// reads as hittable), and a logout pressed there taps the edge of whatever lies under it.
async function logoutHere(v: AuthContext, platform: Platform): Promise<boolean> {
  const door = opt(v, 'DOOR_TEXT', 'Se connecter');
  const out = opt(v, 'LOGOUT_LABEL', 'Se déconnecter');
  const confirm = v.labels(opt(v, 'LOGOUT_CONFIRM_LABELS', out));
  if ((await v.mobPressIf(platform, opt(v, 'MENU_LABEL', 'Menu'))) && !(await v.mobWaitText(platform, out, 5000))) return false;
  // Which buttons already carry a confirm label: the dialog's is the one that was not there. Its place
  // in the tree says nothing (iOS lists the dialog's window before the screen under it, so the last
  // match was the gate's own button again), and both read as hittable.
  const before = new Set(buttonsLabelled((await v.mobTry(platform, 'snapshot', '-i', '--json')).stdout, confirm).map((b) => b.box));
  if (!(await v.mobPressIf(platform, out))) return false;
  if (await v.mobWaitText(platform, door, 6000)) return true;
  const fresh = buttonsLabelled((await v.mobTry(platform, 'snapshot', '-i', '--json')).stdout, confirm).find((b) => !before.has(b.box));
  if (fresh) await v.mobTry(platform, 'press', `@${fresh.ref}`, '--settle');
  return v.mobWaitText(platform, door, 15000);
}

// The keychain / keystore outlives a reinstall, so another persona may still be signed in. Tried where
// the app is, then once more from a cold start: whatever screen, sheet or image viewer the app was left
// on (a viewer over the tab bar once hid « Menu » from the whole login), a relaunch is back on its
// root, where the menu is.
async function logout(v: AuthContext, platform: Platform): Promise<boolean> {
  if (await logoutHere(v, platform)) return true;
  await v.mobileRelaunch(platform);
  return logoutHere(v, platform);
}

export const connector: AuthConnector = {
  describe: (v) => `Auth0 Universal Login on *${domain(v)}*, identifier-first (sign-in: ${opt(v, 'SIGNIN_LABELS', 'Se connecter,Sign in')})`,

  async webLogin(v, persona, url) {
    const { email, password } = v.personaRequire(persona);
    const signin = v.labels(opt(v, 'SIGNIN_LABELS', 'Se connecter,Sign in'));
    const cont = v.labels(opt(v, 'CONTINUE_LABELS', 'Continuer,Continue'));

    await v.web(persona, 'open', url);
    v.step(`open ${url}`);
    // A door carries no form: its button starts the redirect. Other apps land on Auth0 directly.
    const here = await v.webTry(persona, 'get', 'url');
    if (here.code !== 0 || !here.stdout.includes(domain(v))) {
      await v.web(persona, 'wait', 'button');
      if (!(await v.webClickAny(persona, ...signin))) v.die(`login: no sign-in button on ${url} (VYSU_AUTH0_SIGNIN_LABELS)`);
    }
    await v.web(persona, 'wait', '--url', `**${domain(v)}**`);
    v.step(`reach ${domain(v)}`);
    // Identifier-first Universal Login: e-mail, then password on a second page.
    await v.web(persona, 'wait', 'input#username');
    await v.web(persona, 'fill', 'input#username', email);
    if (!(await v.webClickAny(persona, ...cont))) v.die('login: no continue button after the e-mail (VYSU_AUTH0_CONTINUE_LABELS)');
    v.step('fill the e-mail field');
    await v.web(persona, 'wait', 'input#password');
    await v.web(persona, 'fill', 'input#password', password);
    if (!(await v.webClickAny(persona, ...cont))) v.die('login: no continue button after the password (VYSU_AUTH0_CONTINUE_LABELS)');
    v.step('fill the password field');
    const origin = url.replace(/^(https?:\/\/[^/]+).*$/s, '$1');
    await v.web(persona, 'wait', '--url', `${origin}/**`);
    await v.web(persona, 'wait', '2500');
    v.step(`land back on ${origin}`);
    console.log(`logged in: ${persona} (${email}) → ${v.lastLine((await v.webTry(persona, 'get', 'url')).stdout)}`);
  },

  webToken: async (v, persona) => v.value(await v.web(persona, 'eval', TOKEN_JS)),

  mobileLogout: (v, platform) => logout(v, platform),

  // The menu that holds the logout is drawn by the signed-in app only: the door has none.
  mobileSignedIn: (v, platform) => v.mobWaitText(platform, opt(v, 'MENU_LABEL', 'Menu'), 1500),

  async mobileLogin(v, platform, persona) {
    const { email, password } = v.personaRequire(persona);
    const door = opt(v, 'DOOR_TEXT', 'Se connecter');
    const home = opt(v, 'HOME_TEXT', 'Bienvenue');
    const passwordText = opt(v, 'PASSWORD_TEXT', 'mot de passe');
    const after = opt(v, 'AFTER_LOGIN_LABELS', "Entrer directement,Retour à l'accueil");
    const app = v.mobileApp(platform);
    if (!app) v.die('mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set');

    await v.mobilePrepare(platform);
    // Straight onto the bundle, on the app's root, with Expo's dev menu and its intro cleared on the
    // way (only while their own texts show). The dismissal this connector used to press blind,
    // « Close,Fermer » then « Continue,Continuer », found the app's own « Fermer »: the full-screen
    // backdrop of Nidz's closed drawer, pressed at its centre, opened the post under it in an image
    // viewer that then hid « Menu » from the logout (iOS 18 and API 30, 2026-09-24).
    await v.mobileRelaunch(platform);
    await v.mobPressAny(platform, 'Autoriser,Allow'); // push permission, asked at first boot
    if (!(await v.mobWaitText(platform, door, 8000)) && !(await logout(v, platform))) {
      v.die(`${platform}: not on the door screen and no way to log out from here`);
    }
    if (!(await v.mobPressIf(platform, door))) await v.mob(platform, 'press', `text="${door}"`, '--settle');
    await v.mobPressAny(platform, 'Continuer,Continue'); // iOS consent: « … wants to use auth0.com to sign in »
    // The Universal Login runs in a system web surface that agent-device reads through the platform's
    // accessibility. Identifier-first: e-mail, return, password, return.
    if (platform === 'android') {
      // Chrome's first run on a fresh AVD sits in front of the Custom Tab: terms, then the account prompt.
      await v.mobPressAny('android', 'Accepter et continuer,Accept & continue');
      await v.mobPressAny('android', 'Non merci,No thanks');
    }
    // The field's label is the visible « e-mail » one on iOS, a bare "username" in the Custom Tab.
    const form =
      (await v.mobTry(platform, 'wait', 'role="textfield"', '20000')).code === 0 || (await v.mobTry(platform, 'wait', 'id="username"', '8000')).code === 0;
    if (!form) {
      if (platform !== 'ios') v.die(`${platform}: the login form did not show up`);
      // iOS 18 (the old iPhone): agent-device cannot read the SafariViewService sheet. The fields are
      // then read out of the picture (mobFields) rather than tapped at the constants this used to
      // carry (« 57 % and 65 % of the height »), which no longer hold as soon as Auth0 moves a logo.
      // Identifier-first means one field at a time: the first box is the e-mail, and after the
      // submit the same probe, run again on the password page, gives the password.
      let point = await firstField(v, 'ios');
      if (!point) return v.die('ios: no text field found on the sheet (fields saw none)');
      await v.mob('ios', 'press', ...point);
      await v.sleep(1);
      await v.mob('ios', 'type', email);
      await v.mob('ios', 'keyboard', 'return');
      await v.sleep(4);
      point = await firstField(v, 'ios');
      if (!point) return v.die('ios: no password field found after the e-mail (fields saw none)');
      await v.mob('ios', 'press', ...point);
      await v.sleep(1);
      await v.mob('ios', 'type', password);
      await v.mob('ios', 'keyboard', 'return');
      await v.sleep(6);
      await v.mobPressAny('ios', 'Autoriser,Allow');
      await v.mobWaitText('ios', home, 30000);
      await v.mobPressAll('ios', after);
      v.mstateSet('ios', 'persona', persona);
      console.log(`ios: logged in as ${persona} (${email}) — fields read from the capture (iOS 18 sheet not readable)`);
      return;
    }
    if ((await v.mobTry(platform, 'fill', 'role="textfield"', email)).code !== 0) await v.mob(platform, 'fill', 'id="username"', email);
    await submit(v, platform);
    await v.mob(platform, 'wait', 'text', passwordText, '20000');
    if (
      (await v.mobTry(platform, 'fill', 'role="securetextfield"', password)).code !== 0 &&
      (await v.mobTry(platform, 'fill', 'id="password"', password)).code !== 0
    ) {
      await v.mob(platform, 'fill', 'label="Mot de passe"', password);
    }
    await submit(v, platform);
    await v.sleep(3);
    await v.mobPressAny(platform, 'Plus tard,Not Now'); // Safari's « save this password? »
    await v.mobPressAny(platform, 'Autoriser,Allow'); // push notification permission
    await v.mobWaitText(platform, home, 30000);
    // The dev-launcher URL handed over at install is captured as a pending deep link and replayed
    // after login, which the router answers with a not-found screen: a dev-client artefact, not a
    // product bug. AFTER_LOGIN_LABELS is the way back out of it.
    await v.mobPressAll(platform, after);
    // One install is one session: which persona it holds is device state, and the next agent reads it
    // back from `vysu claim` rather than opening the side menu to find out.
    v.mstateSet(platform, 'persona', persona);
    console.log(`${platform}: logged in as ${persona} (${email})`);
  },
};

// The keyboard's return, else the form's own continue button; when neither answers, the login ends
// there (exit 1): the page cannot be submitted.
async function submit(v: AuthContext, platform: Platform): Promise<void> {
  if ((await v.mobTry(platform, 'keyboard', 'return')).code === 0) return;
  if (!(await v.mobPressAny(platform, 'Continuer,Continue'))) exit(1);
}
