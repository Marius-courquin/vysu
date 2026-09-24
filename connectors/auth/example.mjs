// example — the template a project copies to `.vysu/auth.mjs` and fills in. It logs into an app whose
// door is a page of its own, with the functions the engine calls and the primitives it hands each of
// them (`v`, first argument); every line is there to be replaced, and the comments say what the
// engine expects back. A module runs wherever vysu runs, Windows included (`.vysu/auth.sh`, the bash
// form, needs a bash). `.vysu/auth.js` and `.vysu/auth.ts` work the same.
//
// Copy it, then check it with `vysu auth test <persona>`:
//   cp "$VYSU_ENGINE/connectors/auth/example.mjs" .vysu/auth.mjs
//
// Options: a connector reads its own through `v.cfg('<NAME>_<KEY>', '<default>')`, which is the
// config key VYSU_<NAME>_<KEY>. Document them here, with their defaults in brackets, the way the
// built-ins do:
//   VYSU_MYAPP_SIGNIN_LABELS [Se connecter,Sign in]   the door's button
//   VYSU_MYAPP_HOME_TEXT     [Bienvenue]              the text that proves the login held
//
// The primitives (connectors/auth/README.md has the whole list): v.web / v.webTry / v.webClickAny
// for the browser, v.mob / v.mobTry / v.mobPressIf / v.mobPressAny / v.mobPressAll / v.mobWaitText /
// v.mobFields for the device, v.personaRequire / v.personaVar, v.cfg / v.labels, v.die / v.log /
// v.step, v.sleep, v.lastLine / v.value. `v.web(…)` hands back stdout and ends vysu when the call
// fails; `v.webTry(…)` never fails and hands back { code, stdout, stderr }.

const opt = (v, key, def) => v.cfg(`MYAPP_${key}`, def);

// One line for `vysu doctor`: which system this talks to, and the options that are set.
export function describe(v) {
  return `example: a form on the app itself (sign-in: ${opt(v, 'SIGNIN_LABELS', 'Se connecter,Sign in')})`;
}

// The browser session is open and is the persona's own; return with the page logged in on the url's
// origin. `v.step` prints under `vysu auth test` and stays silent the rest of the time.
export async function webLogin(v, persona, url) {
  // The credentials, or vysu ends with the command to run when the persona is not in personas.env.
  // Any other key: v.personaVar(persona, 'TOTP_SECRET').
  const { email, password } = v.personaRequire(persona);

  await v.web(persona, 'open', url);
  v.step(`open ${url}`);
  // A field by its label, then by its placeholder: how a form says what a box is for.
  if (
    (await v.webTry(persona, 'find', 'label', 'E-mail', 'fill', email)).code !== 0 &&
    (await v.webTry(persona, 'fill', 'input[type=email]', email)).code !== 0
  ) {
    v.die(`login: no e-mail field on ${url}`);
  }
  if ((await v.webTry(persona, 'fill', 'input[type=password]', password)).code !== 0) v.die(`login: no password field on ${url}`);
  v.step('fill the credentials');
  // The first visible button among several names: a label differs by language and by version.
  if (!(await v.webClickAny(persona, ...v.labels(opt(v, 'SIGNIN_LABELS', 'Se connecter,Sign in'))))) {
    v.die(`login: no sign-in button on ${url} (VYSU_MYAPP_SIGNIN_LABELS)`);
  }
  v.step('submit');
  // Proof, not a delay: something only the logged-in app shows.
  if ((await v.webTry(persona, 'wait', '--text', opt(v, 'HOME_TEXT', 'Bienvenue'))).code !== 0) {
    v.die('login: never reached the home screen (VYSU_MYAPP_HOME_TEXT)');
  }
  v.step('reach the home screen');
  console.log(`logged in: ${persona} (${email}) → ${v.lastLine((await v.webTry(persona, 'get', 'url')).stdout)}`);
}

// The API access token of the session as it stands, or undefined when the app has none to give (a
// session kept in a cookie no script can read): printing nothing is a valid answer.
export async function webToken(v, persona) {
  return v.value(await v.web(persona, 'eval', "localStorage.getItem('access_token') || ''"));
}

// The app is installed and may be anywhere: on its door, signed in as someone else, or on a
// dev-client launcher. Return with it logged in as the persona, on its home screen.
export async function mobileLogin(v, platform, persona) {
  const { email, password } = v.personaRequire(persona);
  const app = v.mobileApp(platform);
  if (!app) v.die('mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set');
  // The device locked, and on Android Metro's port reversed onto it.
  await v.mobilePrepare(platform);
  // Killed and started again straight onto its bundle, on its root screen, whatever it was left on;
  // vysu ends here, with the reason, when the app cannot start.
  await v.mobileRelaunch(platform);
  v.step(`open ${app}`);

  // A system dialog that may or may not be there, in whatever language the device is in.
  await v.mobPressAny(platform, 'Autoriser,Allow');
  await v.mobPressIf(platform, opt(v, 'SIGNIN_LABELS', 'Se connecter'));

  // Fields by accessibility label, with the roles as the fallback.
  await v.mob(platform, 'fill', 'role="textfield"', email);
  await v.mob(platform, 'fill', 'role="securetextfield"', password);
  await v.mob(platform, 'keyboard', 'return');
  v.step('fill the credentials');

  // A login inside a system web surface (SafariViewService, a Chrome Custom Tab) is invisible to the
  // platform's accessibility: there, the fields are read from the picture instead of guessed at.
  //   const [box] = await v.mobFields(platform);   // [{ x, y, w, h }] in points, top to bottom
  //   await v.mob(platform, 'press', String(box.x + box.w / 2), String(box.y + box.h / 2));

  if (!(await v.mobWaitText(platform, opt(v, 'HOME_TEXT', 'Bienvenue'), 30000))) {
    v.die(`${platform}: never reached the home screen (VYSU_MYAPP_HOME_TEXT)`);
  }
  v.step('reach the home screen');
  // One install is one session: the next agent reads who it holds from `vysu claim`.
  v.mstateSet(platform, 'persona', persona);
  console.log(`${platform}: logged in as ${persona} (${email})`);
}

// Optional: sign whoever is signed in out. True when it did.
export async function mobileLogout(v, platform) {
  return (await v.mobPressIf(platform, opt(v, 'MENU_LABEL', 'Menu'))) && (await v.mobPressIf(platform, opt(v, 'LOGOUT_LABEL', 'Se déconnecter')));
}
