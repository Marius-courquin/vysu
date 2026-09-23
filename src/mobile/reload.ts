// `vysu mreload <platform>`: the JS of this device, reloaded in place: no process kill, no launcher, no
// other device touched. The app's native state (text size, appearance, language) is what it was;
// anything that only a launch applies wants `vysu mrelaunch`.
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { iosLock, type Platform } from '../core/hold.ts';
import { sleep } from '../core/text.ts';
import { adb, androidSelect } from './device.ts';
import { say, trace } from './io.ts';
import { launchState, mobileKind, mrelaunch, recordMetro, waitReady } from './launch.ts';
import {
  bundleErrorSince,
  metroLines,
  metroLog,
  metroNeed,
  metroPageReload,
  metroPageWs,
  metroPort,
  metroTag,
  offsetOfLine,
  readFrom,
  reloadVerdict,
  type ReloadVerdict,
} from './metro.ts';

const nowS = (): number => Math.floor(Date.now() / 1000);

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
  const start = nowS();
  const from = metroLines(log);
  launchState.bundledAt = 0;
  // The reload asks Metro's /status, then the bundle, through `adb reverse`, which an adbd restart
  // since the launch drops (`adb root` for a locale, an adb server restarted by another tool). Without
  // it the app answers the reload with the dev-launcher's « Unable to load script » page (seen on the
  // API 30 emulator: `isMetroRunning(): Async result = false` in logcat), and the landing took a
  // hand-off and a second bundle, 18 s instead of 9. Put back first, it is one adb call.
  if (platform === 'android') await adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
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
  const verdict = await reloadWait(platform, ws, log, from);
  if (verdict.kind === 'fallback') {
    say(`${p}: ${verdict.why}, relaunching instead`);
    return mrelaunch(platform, []);
  }
  recordMetro(platform, port);
  const rc = await waitReady(platform, 30);
  // A reload that ends on a red box may be the reload's own fault (react-native-screens on Android was
  // seen failing to find Fabric's UI manager after one): a clean launch tells it from a real error in
  // the code, which the relaunch then reports the same way.
  if (rc === 2) {
    say(`${p}: the reload ended on a ${launchState.notReady}, relaunching`);
    return mrelaunch(platform, []);
  }
  const note = rc === 0 ? '' : `, ${launchState.notReady}`;
  say(`${p}: reloaded in ${nowS() - start}s (bundled after ${launchState.bundledAt - start}s)${note}`);
}

// Page.reload, then what the page and Metro say until together they prove the reload landed (this
// device's JS context gone, then Metro's « Bundled » for its platform) or show it will not (see
// reloadVerdict). A « Bundling failed » ends it with the error, as a relaunch would.
async function reloadWait(p: Platform, ws: string, log: string, from: number): Promise<ReloadVerdict> {
  const w = metroPageReload(ws);
  if (!w) return { kind: 'fallback', why: 'the inspector page refused the reload' };
  const tag = metroTag(p);
  const re = new RegExp(`(^|[^A-Za-z])${tag} (Bundled|Bundling failed) [0-9]`);
  // The log from the mark on, read from its byte offset: found once, not once per look.
  const off = offsetOfLine(log, from);
  try {
    for (;;) {
      let last = '';
      for (const l of readFrom(log, off).split('\n')) if (re.test(l)) last = l;
      if (last.includes(`${tag} Bundling failed `)) {
        const err = bundleErrorSince(from, log);
        die(`vysu mreload: Metro could not bundle for ${tag}: ${err || `see ${log}`}`, `fix it (the edit may be another session's on the same checkout), then vysu mrelaunch ${p}`);
      }
      const bundled = last.includes(`${tag} Bundled `);
      if (bundled && !launchState.bundledAt) launchState.bundledAt = nowS();
      const v = reloadVerdict(w.seen, Date.now(), bundled);
      if (v.kind !== 'wait') {
        const s = w.seen;
        const at = (t: number): string => (t ? `${((t - s.t0) / 1000).toFixed(1)}s` : '-');
        trace(`reload: runtime ${s.runtime} · sent ${at(s.sentAt)} · acked ${at(s.acked)} · started ${at(s.started)} · created ${at(s.created)} · closed ${at(s.closed)} · bundled ${bundled} → ${v.kind}`);
        return v;
      }
      await sleep(200);
    }
  } finally {
    w.close();
  }
}
