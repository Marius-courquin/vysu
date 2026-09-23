// `vysu mreload <platform>`: the JS of this device, reloaded in place: no process kill, no launcher, no
// other device touched. The app's native state (text size, appearance, language) is what it was;
// anything that only a launch applies wants `vysu mrelaunch`.
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { iosLock, type Platform } from '../core/hold.ts';
import { sleep } from '../core/text.ts';
import { androidSelect } from './device.ts';
import { say } from './io.ts';
import { launchState, mobileKind, mrelaunch, waitBundled, waitReady } from './launch.ts';
import { metroLines, metroLog, metroNeed, metroPageReload, metroPageWs, metroPort } from './metro.ts';

export async function mreload(args: string[]): Promise<void> {
  const p = args[0] ?? '';
  if (p !== 'ios' && p !== 'android') die('usage: vysu mreload ios|android');
  if (args.length > 1) die(`vysu mreload: unknown option ${args[1]}`);
  const platform: Platform = p;
  config().need('MOBILE_BUNDLE', 'the app id on both platforms');
  if (mobileKind() !== 'expo') {
    say(`${p}: a native app has no JS to reload on its own, relaunching instead`);
    return mrelaunch(platform, []);
  }
  if (platform === 'android') await androidSelect();
  else await iosLock();
  await metroNeed('vysu mreload', platform);
  const port = metroPort();
  const log = metroLog(port);
  const start = Math.floor(Date.now() / 1000);
  const from = metroLines(log);
  launchState.bundledAt = 0;
  // The page comes back a moment after the app reconnects to the proxy (a Metro under load drops it):
  // a few looks before giving up on it.
  let ws = '';
  for (let i = 0; i < 5; i++) {
    ws = await metroPageWs(platform, port);
    if (ws) break;
    await sleep(1000);
  }
  if (!ws) {
    // No page of its own: the app is on the launcher, crashed, or shares its name with another
    // emulator. A relaunch is the one reload that is surely this device's.
    say(`${p}: no inspector page of its own on :${port}, relaunching instead`);
    return mrelaunch(platform, []);
  }
  if (!(await metroPageReload(ws))) {
    say(`${p}: the inspector page refused the reload, relaunching instead`);
    return mrelaunch(platform, []);
  }
  await waitBundled(platform, log, from, 60, 'vysu mreload');
  const rc = await waitReady(platform, 30);
  // A reload that ends on a red box may be the reload's own fault (react-native-screens on Android was
  // seen failing to find Fabric's UI manager after one): a clean launch tells it from a real error in
  // the code, which the relaunch then reports the same way.
  if (rc === 2) {
    say(`${p}: the reload ended on a ${launchState.notReady}, relaunching`);
    return mrelaunch(platform, []);
  }
  const note = rc === 0 ? '' : `, ${launchState.notReady}`;
  const now = Math.floor(Date.now() / 1000);
  say(`${p}: reloaded in ${now - start}s (bundled after ${launchState.bundledAt - start}s)${note}`);
}
