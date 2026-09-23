// none — no login at all: `vysu login` opens the url and stops there, `vysu auth token` prints
// nothing. It is what a static site, a Storybook, a marketing page or a public docs app needs, and
// the engine's own default: a project that names no connector gets this one.
//
// Options: none.
import type { AuthConnector } from '../../auth/types.ts';

export const connector: AuthConnector = {
  describe: () => 'no login: the url is opened as it is',

  async webLogin(v, persona, url) {
    await v.web(persona, 'open', url);
    v.step(`open ${url}`);
    await v.web(persona, 'wait', '300');
    console.log(`open: ${persona} → ${v.lastLine((await v.webTry(persona, 'get', 'url')).stdout)}`);
  },

  // There is no token to find, and no failure in that: a caller that seeds a request with one is
  // simply handed an empty string.
  webToken: async () => undefined,

  async mobileLogin(v, platform, persona) {
    const app = v.mobileApp(platform);
    if (!app) v.die('mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set');
    if ((await v.mobTry(platform, 'open', app, '--foreground', '--relaunch', '--timeout', '600000')).code !== 0) {
      v.die(`${platform}: cannot open the app (vysu up ${platform} --build?)`);
    }
    await v.mobileLoadBundle(platform);
    v.step(`open ${app}`);
    v.mstateSet(platform, 'persona', persona);
    console.log(`${platform}: ${app} opened (this app asks for no login)`);
  },

  mobileLogout: async () => true,
};
