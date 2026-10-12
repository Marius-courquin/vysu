// auth0 — Auth0 Universal Login, identifier-first: e-mail on one page, password on the next, each
// carrying two submit buttons (one hidden) so the visible one is found by role and name. The token
// is read out of the auth0-spa-js cache in localStorage. On mobile the login runs in a system web
// surface (SafariViewService / Chrome Custom Tab), behind a handful of OS dialogs.
//
// Options (defaults in brackets):
//   VYSU_AUTH0_DOMAIN             [auth0.com]                     what an Auth0 url looks like
//   VYSU_AUTH0_SIGNIN_LABELS      [Se connecter,Sign in]          the door's button, web and mobile
//   VYSU_AUTH0_SIGNIN_WAIT        [15]                            web: seconds the door's button is waited for
//   VYSU_AUTH0_CONTINUE_LABELS    [Continuer,Continue]            Universal Login's submit
//   VYSU_AUTH0_DOOR_TEXT          [Se connecter]                  the mobile door screen's text
//   VYSU_AUTH0_DOOR_WAIT          [30]                            mobile: seconds the door (or someone signed in) may take to show
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

// Who the session is signed in as: the e-mail of the id token auth0-spa-js caches, '' when it holds none.
const USER_JS =
  "(() => { for (const k of Object.keys(localStorage)) { if (!k.startsWith('@@auth0spajs@@')) continue; try { const t = JSON.parse(localStorage.getItem(k) || '{}'); const u = (t.decodedToken || (t.body && t.body.decodedToken) || {}).user; if (u && u.email) return u.email; } catch (e) {} } return ''; })()";

// When the session's cached login runs out, in seconds since the epoch: the latest `expiresAt`
// auth0-spa-js wrote beside an access token, 0 when it holds none. The app refreshes it on load when it
// can, so a login read as expired after the page settled is one the app could not renew.
const EXPIRES_JS =
  "(() => { let at = 0; for (const k of Object.keys(localStorage)) { if (!k.startsWith('@@auth0spajs@@') || k.endsWith('@@user@@')) continue; try { const t = JSON.parse(localStorage.getItem(k) || '{}'); if (t.body && t.body.access_token && Number(t.expiresAt) > at) at = Number(t.expiresAt); } catch (e) {} } return String(at); })()";

// A login held, still valid and not sent to a door: what « already signed in » needs, all three. The
// identity cache alone outlives the token by days, and a page that has not moved yet may be a door.
export function stillSignedIn(expiresAt: number, nowSeconds: number, door: boolean): boolean {
  return !door && expiresAt > nowSeconds + 30;
}

// What the page shows, for a login that found no way in: where it is, and the names of what can be
// clicked on it.
const PAGE_JS =
  "JSON.stringify({ url: location.href, names: [...document.querySelectorAll('button, [role=button], a[href], input[type=submit]')].filter(e => e.getClientRects().length).map(e => (e.getAttribute('aria-label') || e.textContent || e.value || '').replace(/\\s+/g, ' ').trim()).filter(Boolean) })";

// Whether that page is a door: one of its buttons carries a sign-in label.
export function showsDoor(json: string, signin: string[]): boolean {
  try {
    const want = signin.map((l) => l.toLocaleLowerCase());
    return ((JSON.parse(json) as { names?: string[] }).names ?? []).some((n) => want.includes(n.toLocaleLowerCase()));
  } catch {
    return false;
  }
}

export function pageSays(json: string): string {
  let p: { url?: string; names?: string[] } = {};
  try {
    p = JSON.parse(json) as typeof p;
  } catch {
    return 'the page could not be read';
  }
  const names = [...new Set(p.names ?? [])];
  const shown = names.slice(0, 8).map((n) => `« ${n.length > 40 ? `${n.slice(0, 39)}…` : n} »`);
  const more = names.length > shown.length ? ` and ${names.length - shown.length} more` : '';
  return `the page is ${p.url || '(unknown)'}, ${shown.length ? `its buttons and links: ${shown.join(', ')}${more}` : 'with no button nor link (still loading?)'}`;
}

// The centre of the first text field on screen, in what a press takes, for the surfaces the
// platform's accessibility cannot read: the picture is all there is to go by there.
async function firstField(v: AuthContext, platform: Platform): Promise<[string, string] | null> {
  const box = (await v.mobFields(platform))[0];
  if (!box) return null;
  return [String(Math.floor(box.x + Math.floor(box.w / 2))), String(Math.floor(box.y + Math.floor(box.h / 2)))];
}

// A text typed into the field at that point. A press that does not give the field the focus yet (the
// sheet still settling) leaves agent-device with nowhere to type: TEXT_INPUT_NOT_FOCUSED, 13 failed
// iOS logins in the audit of 2026-10-12. Pressed again, a little later, and typed once more.
async function typeAt(v: AuthContext, platform: Platform, point: [string, string], text: string): Promise<void> {
  await v.mob(platform, 'press', ...point);
  await v.sleep(1);
  if ((await v.mobTry(platform, 'type', text)).code === 0) return;
  await v.mob(platform, 'press', ...point);
  await v.sleep(2);
  await v.mob(platform, 'type', text);
}

// The text into the first of these fields that is on screen. agent-device's fill presses the field and
// types, then reads the field back, and two things go wrong there on a loaded machine: the press does
// not give the focus (TEXT_INPUT_NOT_FOCUSED, iOS) and the read-back does not match (« Android fill
// verification failed », 13 Android logins in the audit, in the Custom Tab). The field is then pressed
// and filled once more; read back; and last cleared and typed into. '' when it took, else what
// agent-device said.
const FILL_MISSED = /TEXT_INPUT_NOT_FOCUSED|fill verification failed|could not confirm masked/;
export async function fillField(v: AuthContext, platform: Platform, selectors: string[], text: string): Promise<string> {
  let said = '';
  for (const sel of selectors) {
    const r = await v.mobTry(platform, 'fill', sel, text);
    if (r.code === 0) return '';
    said = `${r.stderr}${r.stdout}`.trim();
    // Not on screen by that selector: the next one.
    if (!FILL_MISSED.test(said)) continue;
    await v.mobTry(platform, 'press', sel);
    await v.sleep(1);
    const again = await v.mobTry(platform, 'fill', sel, text);
    if (again.code === 0) return '';
    const got = await v.mobTry(platform, 'get', 'text', sel);
    if (got.code === 0 && got.stdout.includes(text)) return '';
    await v.mobTry(platform, 'fill', sel, '');
    const typed = await v.mobTry(platform, 'type', text);
    if (typed.code === 0) return '';
    said = `${typed.stderr}${typed.stdout}`.trim();
  }
  return said.split('\n').find((l) => /Error/.test(l)) ?? said.split('\n')[0] ?? '';
}

// The door, or someone already signed in: whichever shows first, looked for in turns for up to
// VYSU_AUTH0_DOOR_WAIT seconds. The door was given 8 s, and on a loaded machine the first screen took
// longer than that: 54 Android logins ended « not on the door screen » on a door still coming
// (2026-09/10). A signed-in app is no reason to wait for the door: it is logged out at once.
async function doorOrSignedIn(v: AuthContext, platform: Platform): Promise<'door' | 'in' | ''> {
  const door = opt(v, 'DOOR_TEXT', 'Se connecter');
  const menu = opt(v, 'MENU_LABEL', 'Menu');
  const s = Number(opt(v, 'DOOR_WAIT', '30'));
  const budget = Number.isFinite(s) && s > 0 ? s * 1000 : 30000;
  const slice = 4000;
  for (let left = budget; left > 0; left -= slice + 1500) {
    if (await v.mobWaitText(platform, door, Math.min(slice, left))) return 'door';
    if (await v.mobWaitText(platform, menu, 1500)) return 'in';
  }
  return '';
}

// The login form inside the system web surface, by role (the visible « e-mail » field on iOS) or by
// the bare `username` id Auth0 gives it in the Custom Tab.
async function formShows(v: AuthContext, platform: Platform): Promise<boolean> {
  return (await v.mobTry(platform, 'wait', 'role="textfield"', '20000')).code === 0 || (await v.mobTry(platform, 'wait', 'id="username"', '8000')).code === 0;
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

// A profile that never saw Auth0 — the first login of every new session — gets a page that drops the
// first click it is given while it is still setting itself up: no request leaves, and the password
// field never comes. Clicked again, up to three times, until it does.
async function continueTo(v: AuthContext, persona: string, cont: string[], field: string): Promise<void> {
  const shown = `!!document.querySelector(${JSON.stringify(field)})`;
  for (let i = 0; i < 3; i++) {
    if (!(await v.webClickAny(persona, ...cont))) v.die('login: no continue button after the e-mail (VYSU_AUTH0_CONTINUE_LABELS)');
    for (let t = 0; t < 12; t++) {
      if (v.value((await v.webTry(persona, 'eval', shown)).stdout) === 'true') return;
      await v.sleep(0.5);
    }
  }
  await v.web(persona, 'wait', field);
}

// What gives a session a clean start: its browser closed and its saved state dropped. Clearing its
// cookies and storage by hand once sent the next login back to the door.
const fresh = (persona: string): string =>
  `vysu ${persona} close, delete its file in ~/.agent-browser/sessions/ (the session's name twice), then vysu login ${persona}`;

async function onAuth0(v: AuthContext, persona: string): Promise<boolean> {
  const here = await v.webTry(persona, 'get', 'url');
  return here.code === 0 && here.stdout.includes(domain(v));
}

// Up to `seconds` for the Auth0 page, which a click on the door's button starts loading.
async function reachAuth0(v: AuthContext, persona: string, seconds: number): Promise<boolean> {
  for (let t = 0; t < seconds * 2; t++) {
    if (await onAuth0(v, persona)) return true;
    await v.sleep(0.5);
  }
  return onAuth0(v, persona);
}

// Up to `seconds` for a door's button or for the Auth0 page, whichever shows first; true once a button
// was clicked.
async function nextDoor(v: AuthContext, persona: string, signin: string[], seconds: number): Promise<boolean> {
  for (let t = 0; t <= seconds * 2; t++) {
    if (await onAuth0(v, persona)) return false;
    if (await v.webClickAny(persona, ...signin)) return true;
    await v.sleep(0.5);
  }
  return false;
}

// From the app to Auth0. A door's button starts the redirect, and a door may lead to another: Nidz V2's
// / says « Commencer », which leads to /auth/login, whose « Se connecter » leads to Auth0. Both pages
// draw a loader first, and a dev build mounts its devtools buttons before them: `wait button` answered
// on those, the one look for the label that followed found nothing, and 237 logins of the audit died on
// « no sign-in button » (2026-09-25 → 10-12, 143 of them on localhost:8100/auth/login). So the label
// is looked for until it shows (VYSU_AUTH0_SIGNIN_WAIT), and a click that lands on another door rather
// than on Auth0 is followed, three doors at most. A session that already holds this persona's login
// is no failure: the app shows its home instead of a door, and there is nothing to do. True then.
async function door(v: AuthContext, persona: string, url: string, signin: string[], email: string): Promise<boolean> {
  const wait = Math.max(0, Number(opt(v, 'SIGNIN_WAIT', '15')) || 0);
  const holder = v.value((await v.webTry(persona, 'eval', USER_JS)).stdout);
  // A session that holds a login is expected on the app's home: the door is given a short look, then
  // the rest of the wait only if the page is still the one that was opened (a session whose login has
  // expired shows the door, after the same loader).
  const first = holder ? Math.min(wait, 4) : wait;
  let clicked = await v.webClickAny(persona, ...signin, { wait: first });
  if (!clicked && holder) {
    const at = v.lastLine((await v.webTry(persona, 'get', 'url')).stdout);
    const page = v.value((await v.webTry(persona, 'eval', PAGE_JS)).stdout);
    const expires = Number(v.value((await v.webTry(persona, 'eval', EXPIRES_JS)).stdout)) || 0;
    if (at.replace(/\/$/, '') !== url.replace(/\/$/, '') && stillSignedIn(expires, Math.floor(Date.now() / 1000), showsDoor(page, signin))) {
      if (holder.toLowerCase() !== email.toLowerCase()) {
        v.die(
          `login: this session is signed in as ${holder}, not ${email} (${pageSays(page)})`,
          fresh(persona),
        );
      }
      console.log(`logged in: ${persona} (${email}) → ${at} (already signed in: nothing done)`);
      return true;
    }
    clicked = await v.webClickAny(persona, ...signin, { wait: wait - first });
  }
  if (!clicked) {
    v.die(`login: no sign-in button on ${url} after ${wait}s: ${pageSays(v.value((await v.webTry(persona, 'eval', PAGE_JS)).stdout))} (VYSU_AUTH0_SIGNIN_LABELS, VYSU_AUTH0_SIGNIN_WAIT)`);
  }
  v.step('click the sign-in button');
  // A redirect slower than this is clicked again only if the page still shows a door's button by
  // then; a click the page dropped (it was still setting itself up) is clicked again the same way.
  for (let hop = 1; hop < 3; hop++) {
    if (await reachAuth0(v, persona, 8)) return false;
    if (!(await nextDoor(v, persona, signin, wait))) return false;
    v.step('click the next sign-in button');
  }
  return false;
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
    if (!(await onAuth0(v, persona)) && (await door(v, persona, url, signin, email))) return;
    await v.web(persona, 'wait', '--url', `**${domain(v)}**`);
    v.step(`reach ${domain(v)}`);
    // Identifier-first Universal Login: e-mail, then password on a second page.
    await v.web(persona, 'wait', 'input#username');
    await v.web(persona, 'fill', 'input#username', email);
    await continueTo(v, persona, cont, 'input#password');
    v.step('fill the e-mail field');
    await v.web(persona, 'fill', 'input#password', password);
    if (!(await v.webClickAny(persona, ...cont))) v.die('login: no continue button after the password (VYSU_AUTH0_CONTINUE_LABELS)');
    v.step('fill the password field');
    const origin = url.replace(/^(https?:\/\/[^/]+).*$/s, '$1');
    await v.web(persona, 'wait', '--url', `${origin}/**`);
    await v.web(persona, 'wait', '2500');
    // Auth0 let the persona through and the app came back to its door, with no login in the session:
    // the app never took the code. Seen on a session whose cookies and storage had been cleared by
    // hand, where the login still said « logged in » (2026-10-12).
    if (!v.value((await v.webTry(persona, 'eval', USER_JS)).stdout)) {
      const page = v.value((await v.webTry(persona, 'eval', PAGE_JS)).stdout);
      if (showsDoor(page, signin)) v.die(`login: Auth0 took the password, but the app is back on its door with no login: ${pageSays(page)}`, fresh(persona));
    }
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
    const first = await doorOrSignedIn(v, platform);
    if (first !== 'door' && !(await logout(v, platform))) {
      // No logout within reach (a screen with no menu, a gate the labels do not name): on Android the
      // app's data is wiped instead, which signs anyone out, and the door is looked for again. Only
      // when the app shows its own signed-in screens, though: a door that simply has not shown yet (a
      // bundle still loading, Expo's loader, the app in another language than DOOR_TEXT) is no reason to
      // wipe a login and everything the app keeps.
      const own = first === 'in' || (await v.mobWaitText(platform, opt(v, 'MENU_LABEL', 'Menu'), 1500)) || (await v.mobWaitText(platform, opt(v, 'LOGOUT_LABEL', 'Se déconnecter'), 1500));
      if (!own) {
        v.die(
          `${platform}: not on the door screen: neither « ${door} » nor the app's « ${opt(v, 'MENU_LABEL', 'Menu')} » showed (still loading, Expo's loader, another language?); the app data is left as it is (VYSU_AUTH0_DOOR_TEXT, VYSU_AUTH0_DOOR_WAIT)`,
        );
      }
      if (!(await v.mobileReset(platform)) || (await doorOrSignedIn(v, platform)) !== 'door') {
        v.die(`${platform}: not on the door screen and no way to log out from here${platform === 'android' ? ' (nor after clearing the app data)' : ''}`);
      }
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
    // An ANR dialog (Chrome's own, under load) over the Custom Tab hides the form: answered first.
    let form = await formShows(v, platform);
    if (!form && (await v.mobileUnblock(platform))) form = await formShows(v, platform);
    if (!form) {
      // The form is on screen and not in the tree: agent-device cannot read the SafariViewService
      // sheet on iOS 18 (the old iPhone), nor Auth0's fields in the Custom Tab on API 30 (Pixel 4a). The
      // fields are then read out of the picture (mobFields) rather than tapped at the constants this
      // used to carry (« 57 % and 65 % of the height »), which no longer hold as soon as Auth0 moves a
      // logo. Identifier-first means one field at a time: the first box is the e-mail, and after the
      // submit the same probe, run again on the password page, gives the password.
      const surface = platform === 'ios' ? 'sheet' : 'Custom Tab';
      let point = await firstField(v, platform);
      if (!point) return v.die(`${platform}: the login form did not show up: no text field in the tree nor on the ${surface} (fields saw none)`);
      await typeAt(v, platform, point, email);
      await v.mob(platform, 'keyboard', 'return');
      await v.sleep(4);
      point = await firstField(v, platform);
      if (!point) return v.die(`${platform}: no password field found after the e-mail (fields saw none)`);
      await typeAt(v, platform, point, password);
      await v.mob(platform, 'keyboard', 'return');
      await v.sleep(6);
      await v.mobPressAny(platform, 'Autoriser,Allow');
      await v.mobWaitText(platform, home, 30000);
      await v.mobPressAll(platform, after);
      v.mstateSet(platform, 'persona', persona);
      console.log(`${platform}: logged in as ${persona} (${email}) — fields read from the capture (${surface} not readable)`);
      return;
    }
    let missed = await fillField(v, platform, ['role="textfield"', 'id="username"'], email);
    if (missed) v.die(`${platform}: the e-mail field could not be filled: ${missed}`);
    await submit(v, platform);
    await v.mob(platform, 'wait', 'text', passwordText, '20000');
    missed = await fillField(v, platform, ['role="securetextfield"', 'id="password"', 'label="Mot de passe"'], password);
    if (missed) v.die(`${platform}: the password field could not be filled: ${missed}`);
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
