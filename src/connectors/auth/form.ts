// form — a plain same-origin login form: an e-mail, a password and a submit button, all on the page
// the login url opens. The fields are looked for by label first, then by placeholder, then by their
// input type; the button by role and name; and the login counts as done when the page has navigated
// away from the login url. A token is optional and the project says where it is, since a form app
// keeps it wherever it likes (a cookie no script can read, a store, a global).
//
// Options (defaults in brackets):
//   VYSU_FORM_EMAIL_LABELS    [E-mail,Email,Adresse e-mail,Identifiant,Username]
//   VYSU_FORM_PASSWORD_LABELS [Mot de passe,Password]
//   VYSU_FORM_SUBMIT_LABELS   [Se connecter,Connexion,Sign in,Log in,Login,Submit]
//   VYSU_FORM_TOKEN_JS        []   an expression evaluated in the page whose value is the token
//   VYSU_FORM_HOME_TEXT       []   mobile: the text(s) that prove the login, comma-separated;
//                                  falls back to VYSU_MOBILE_READY_TEXT, then to a fixed wait
//
// Mobile: the same, by accessibility label — the labels above are matched against what the platform
// announces, and the app is home when it shows one of VYSU_FORM_HOME_TEXT.
import type { AuthConnector, AuthContext } from '../../auth/types.ts';
import { exit } from '../../core/errors.ts';
import type { Platform } from '../../core/hold.ts';

const opt = (v: AuthContext, key: string, def: string): string => v.cfg(`FORM_${key}`, def);
const emailLabels = (v: AuthContext): string => opt(v, 'EMAIL_LABELS', 'E-mail,Email,Adresse e-mail,Identifiant,Username');
const passwordLabels = (v: AuthContext): string => opt(v, 'PASSWORD_LABELS', 'Mot de passe,Password');
const submitLabels = (v: AuthContext): string => opt(v, 'SUBMIT_LABELS', 'Se connecter,Connexion,Sign in,Log in,Login,Submit');

// A field by label, then by placeholder, then by input type: the three ways a form says what a box
// is for, in the order of how much the page meant it.
async function fill(v: AuthContext, persona: string, labels: string, type: string, value: string): Promise<boolean> {
  for (const label of v.labels(labels)) {
    if ((await v.webTry(persona, 'find', 'label', label, 'fill', value)).code === 0) return true;
    if ((await v.webTry(persona, 'find', 'placeholder', label, 'fill', value)).code === 0) return true;
  }
  return (await v.webTry(persona, 'fill', `input[type=${type}]`, value)).code === 0;
}
// The submit button by role and name, then the form's own submit control: a button carrying an icon
// and no text has no accessible name to be found by.
async function submit(v: AuthContext, persona: string): Promise<boolean> {
  for (const label of v.labels(submitLabels(v))) if (await v.webClickAny(persona, label)) return true;
  return (await v.webTry(persona, 'click', 'button[type=submit], input[type=submit]')).code === 0;
}
// Logged in = gone from the login url. A form that answers in place (an error under the field) never
// navigates, which is exactly the failure this has to name.
async function waitAway(v: AuthContext, persona: string, loginUrl: string, seconds = 20): Promise<string | null> {
  const login = loginUrl.replace(/\/$/, '');
  for (let i = 0; i < seconds; i++) {
    const here = v.lastLine((await v.webTry(persona, 'get', 'url')).stdout);
    const bare = here.replace(/\/$/, '');
    // about:blank is the beat between the submit and the next document, not a destination.
    if (bare !== '' && bare !== 'about:blank' && bare !== login) return here;
    await v.sleep(1);
  }
  return null;
}
// A field by accessibility label, then by role: a platform announces a form field by the label the
// app gave it, and by nothing at all when it gave none.
async function mobFill(v: AuthContext, platform: Platform, labels: string, role: string, value: string): Promise<boolean> {
  for (const label of v.labels(labels)) {
    if ((await v.mobTry(platform, 'fill', `label="${label}"`, value)).code === 0) return true;
  }
  return (await v.mobTry(platform, 'fill', role, value)).code === 0;
}

export const connector: AuthConnector = {
  describe: (v) =>
    `a login form on the page itself (fields: ${emailLabels(v)} / ${passwordLabels(v)}, submit: ${submitLabels(v)}, token: ${opt(v, 'TOKEN_JS', '') ? 'VYSU_FORM_TOKEN_JS' : 'none'})`,

  async webLogin(v, persona, url) {
    const { email, password } = v.personaRequire(persona);
    await v.web(persona, 'open', url);
    v.step(`open ${url}`);
    if (!(await fill(v, persona, emailLabels(v), 'email', email))) v.die(`login: no e-mail field on ${url} (VYSU_FORM_EMAIL_LABELS)`);
    v.step('fill the e-mail field');
    if (!(await fill(v, persona, passwordLabels(v), 'password', password))) v.die(`login: no password field on ${url} (VYSU_FORM_PASSWORD_LABELS)`);
    v.step('fill the password field');
    if (!(await submit(v, persona))) v.die(`login: no submit button on ${url} (VYSU_FORM_SUBMIT_LABELS)`);
    v.step('submit');
    const here = await waitAway(v, persona, url);
    if (here === null) v.die(`login: still on ${url} after the submit — the credentials were refused, or the form answers in place`);
    v.step('leave the login page');
    // The page the app lands on is the one the next capture is of, and the one a token is read from:
    // let it finish loading before saying the login is done.
    await v.webTry(persona, 'wait', '--load', 'networkidle', '--timeout', '5000');
    await v.web(persona, 'wait', '500');
    console.log(`logged in: ${persona} (${email}) → ${here}`);
  },

  async webToken(v, persona) {
    const js = opt(v, 'TOKEN_JS', '');
    if (!js) return undefined;
    const r = await v.webTry(persona, 'eval', js);
    if (r.code !== 0) exit(r.code);
    return v.value(r.stdout);
  },

  mobileLogout: async () => true,

  async mobileLogin(v, platform, persona) {
    const { email, password } = v.personaRequire(persona);
    const app = v.mobileApp(platform);
    if (!app) v.die('mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set');
    await v.mobilePrepare(platform);
    if ((await v.mobTry(platform, 'open', app, '--foreground', '--relaunch', '--timeout', '600000')).code !== 0) {
      v.die(`${platform}: cannot open the app (vysu up ${platform} --build?)`);
    }
    await v.mobileLoadBundle(platform);
    v.step(`open ${app}`);
    await v.mobPressAny(platform, 'Autoriser,Allow'); // push permission, asked at first boot
    if ((await v.mobTry(platform, 'wait', 'role="textfield"', '20000')).code !== 0) v.die(`${platform}: no text field on the login screen`);
    if (!(await mobFill(v, platform, emailLabels(v), 'role="textfield"', email))) v.die(`${platform}: no e-mail field (VYSU_FORM_EMAIL_LABELS)`);
    v.step('fill the e-mail field');
    if (!(await mobFill(v, platform, passwordLabels(v), 'role="securetextfield"', password))) {
      v.die(`${platform}: no password field (VYSU_FORM_PASSWORD_LABELS)`);
    }
    v.step('fill the password field');
    if (!(await v.mobPressAny(platform, submitLabels(v)))) await v.mob(platform, 'keyboard', 'return');
    v.step('submit');
    // Home is one of the screens the project named: the app under test is the only thing that knows
    // what the other side of its own login looks like.
    const ready = opt(v, 'HOME_TEXT', v.cfg('MOBILE_READY_TEXT'));
    if (ready) {
      let seen = false;
      for (const text of v.labels(ready)) {
        if (await v.mobWaitText(platform, text, 20000)) {
          seen = true;
          break;
        }
      }
      if (!seen) v.die(`${platform}: none of VYSU_FORM_HOME_TEXT showed up after the submit`);
      v.step('the app is home');
    } else {
      await v.sleep(5);
    }
    // One install is one session: which persona it holds is device state, and the next agent reads it
    // back from `vysu claim` rather than opening the app to find out.
    v.mstateSet(platform, 'persona', persona);
    console.log(`${platform}: logged in as ${persona} (${email})`);
  },
};
