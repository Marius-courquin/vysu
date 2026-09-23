// `vysu up ios|android` and `vysu down metro|applog`: the device, and what runs in front of the app —
// Metro in expo mode, nothing in native mode, where `up` installs the app and tails its log. Expo and
// simulator mechanics, not app logic: the emulator, the dev-client build and its install.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { androidLock, deviceRemember, devices, iosLock, type Platform } from '../core/hold.ts';
import { isWindows } from '../core/host.ts';
import { listening } from '../core/net.ts';
import { run, spawnDetached } from '../core/proc.ts';
import { sleep } from '../core/text.ts';
import { applogStart, applogStop } from './applog.ts';
import { adb, adbShell, androidSerial, forgetSerial, iosFreezeStatusBar, iosUdid, serial, waitAndroidBoot, waitAndroidSerial, waitAndroidShell } from './device.ts';
import { say } from './io.ts';
import { mobileKind, mrelaunch, quietDevMenu } from './launch.ts';
import { metroDown, metroIsIsolated, metroIsolatedUp, metroNeed, metroPort, metroSharedUp, worktreeMobileDir } from './metro.ts';
import { startEmulator } from './pool.ts';
import { crlf, xcrun } from './tools.ts';

// What `up <platform> --build` runs. A native project names it (`xcodebuild …`, `./gradlew …`); an
// Expo one gets the `expo run:` line it always had, so the two kinds share one code path.
function buildCommand(p: Platform): string {
  const cmd = config().get(p === 'ios' ? 'MOBILE_BUILD_IOS' : 'MOBILE_BUILD_ANDROID');
  if (cmd || mobileKind() !== 'expo') return cmd;
  return `npx expo run:${p} --device "${devices.of(p)}" --no-bundler`;
}

// Where the app to install comes from when the device has none: the path the project names in native
// mode, the last dev-client build in expo mode (Xcode's DerivedData, gradle's debug apk).
function appArtifact(p: Platform, mdir: string): string {
  if (mobileKind() === 'native') return config().projectPath(config().get(p === 'ios' ? 'IOS_APP_PATH' : 'ANDROID_APK'));
  if (p === 'android') return join(mdir, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const derived = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  let best = '';
  let bestT = -1;
  try {
    for (const d of readdirSync(derived)) {
      const products = join(derived, d, 'Build', 'Products', 'Debug-iphonesimulator');
      let apps: string[] = [];
      try {
        apps = readdirSync(products).filter((a) => a.endsWith('.app'));
      } catch {
        continue;
      }
      for (const a of apps) {
        const t = statSync(join(products, a)).mtimeMs;
        if (t > bestT) {
          bestT = t;
          best = join(products, a);
        }
      }
    }
  } catch {
    // no Xcode build here
  }
  return best;
}

// Is the app on the device? `get_app_container` answers for a system app too; the Android side
// matches the package list on its own line.
async function installed(p: Platform, bundle: string): Promise<boolean> {
  if (p === 'ios') return (await xcrun(['simctl', 'get_app_container', await iosUdid(), bundle, 'app'])).code === 0;
  return crlf((await adb(['shell', 'pm', 'list', 'packages', bundle])).stdout).includes(`package:${bundle}`);
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export async function mobileUp(p: Platform, args: string[]): Promise<void> {
  const kind = mobileKind();
  let build = false;
  let reinstall = false;
  let isolated = false;
  let isoPort = '';
  let isoDir = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = (): string => args[++i] ?? '';
    if (a === '--avd') {
      devices.android = v();
      forgetSerial();
      deviceRemember('android-avd', devices.android);
      devices.named('android');
    } else if (a === '--device') {
      devices.ios = v();
      deviceRemember('ios-device', devices.ios);
      devices.named('ios');
    } else if (a === '--build') build = true;
    else if (a === '--reinstall') reinstall = true;
    else if (a === '--isolated') isolated = true;
    else if (a === '--port') isoPort = v();
    else if (a === '--dir') isoDir = v();
    else die(`vysu up ${p}: unknown option ${a}`);
  }
  if (!isolated && (isoPort || isoDir)) die(`vysu up ${p}: --port and --dir go with --isolated`);
  if (isolated && kind !== 'expo') die(`vysu up ${p} --isolated: a native app has no Metro to isolate`);
  const bundle = config().need('MOBILE_BUNDLE', 'the app id on both platforms');
  // Where a build runs: the mobile app's folder when the project names one, the project itself
  // otherwise — a native app often has no folder of its own to point at.
  const mdir = config().mobileDir || config().projectDir || process.cwd();
  if (kind === 'expo' && !isDir(mdir)) die(`vysu up ${p}: VYSU_MOBILE_DIR does not point at the Expo app`);
  // The env the app was built for: Metro's manifest (the app config → scheme, api url…) must be
  // generated for the same env, or the login callback scheme does not match.
  const menv = config().get('MOBILE_ENV').split(/\s+/).filter(Boolean);
  if (build) {
    const cmd = buildCommand(p);
    const key = p === 'ios' ? 'MOBILE_BUILD_IOS' : 'MOBILE_BUILD_ANDROID';
    if (!cmd) die(`vysu up ${p} --build: VYSU_${key} is not set (the command that builds the app)`);
    const env = config().childEnv();
    for (const pair of menv) {
      const eq = pair.indexOf('=');
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const log = join(config().logs, `${p}-build.log`);
    // Fire-and-forget, but not silent about how it ended: the last line of the log is the exit
    // status, so a `tail` answers « did it build? » without reading the tool's own wording.
    if (isWindows) {
      spawnDetached(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/v:on', '/c', `${cmd} & echo vysu: ${p} build exited !ERRORLEVEL!`], { cwd: mdir, env, log });
    } else {
      spawnDetached('/bin/sh', ['-c', `${cmd}\nrc=$?\necho "vysu: ${p} build exited $rc"\nexit $rc`], { cwd: mdir, env, log });
    }
    say(`${p}: build started in ${mdir} (5-10 min the first time) — tail -f ${log}`);
    return;
  }
  // The Metro this owner talks to. Shared by default (one checkout, one bundler, several sessions);
  // --isolated starts one for this owner alone, from its own checkout: without --dir, the worktree the
  // command runs in, when it belongs to the repository that holds VYSU_MOBILE_DIR.
  if (isolated) {
    if (!isoDir) {
      isoDir =
        worktreeMobileDir() ??
        die(`vysu up ${p} --isolated: this folder is not a worktree of the mobile app's repository`, `vysu up ${p} --isolated --dir <the Expo app folder to serve>`);
    }
    try {
      isoDir = realpathSync(isoDir);
    } catch {
      die(`vysu up ${p} --isolated: no such folder`);
    }
    await metroIsolatedUp(p, isoPort, isoDir, menv);
  } else if (kind === 'expo') {
    const mport = metroPort();
    if (!(await listening(Number(mport)))) {
      if (metroIsIsolated()) await metroNeed(`vysu up ${p}`, p);
      await metroSharedUp(mdir, mport, menv);
    }
  }
  const port = metroPort();
  const artifact = appArtifact(p, mdir);
  if (p === 'android') {
    await androidLock();
    const avd = devices.android;
    // Emulators run side by side, each addressed by its serial (4 GB of RAM each, so two at most in
    // practice): the one asked for is started when it is not attached, the others are left alone.
    if (!(await androidSerial())) {
      startEmulator(avd);
      await waitAndroidSerial();
    }
    serial.value = await androidSerial();
    process.env.ANDROID_SERIAL = serial.value;
    await waitAndroidBoot();
    // A Google APIs image accepts adb root, so the locale the UI is reviewed in is set once.
    const locale = config().get('ANDROID_LOCALE');
    if (locale && (await adbShell(['getprop', 'persist.sys.locale'])).trim() !== locale) {
      if ((await adb(['root'])).code === 0) await adb(['shell', `setprop persist.sys.locale ${locale}; setprop ctl.restart zygote`]);
      // A zygote restart brings `sys.boot_completed` back to 1 well before the system services are:
      // `up` used to return on a device whose activity manager still answered « is the system
      // running? », taking the app-log's dumpsys and the first launch down with it.
      await sleep(20000);
      await waitAndroidBoot();
      await waitAndroidShell();
    }
    // Metro reachable as localhost from the emulator (adbd restarts drop it): expo only.
    if (kind === 'expo') await adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
    if (reinstall || !(await installed('android', bundle))) {
      if (artifact && isFile(artifact) && (await adb(['install', '-r', artifact])).code === 0) say(`android: ${bundle} installed on ${avd} (from ${artifact})`);
      else if (kind === 'native') say(`android: no ${bundle} on ${avd} — set VYSU_ANDROID_APK, or vysu up android --build`);
      else say(`android: no dev-client on ${avd} (vysu up android --build)`);
    } else if (kind === 'native') say(`android: ${bundle} already installed on ${avd}`);
    if (kind === 'expo') {
      if (await installed('android', bundle)) await quietDevMenu('android', bundle);
      say(`android: Metro on ${port}, ${avd} booted on ${serial.value} → vysu android open ${bundle} --foreground`);
    } else {
      await applogStart('android');
      say(`android: ${avd} booted on ${serial.value} → vysu android open ${bundle} --foreground`);
    }
  } else {
    await iosLock();
    const dev = devices.ios;
    // Start of a mobile session: the one place where looking the UDID up again is worth it.
    const udid = await iosUdid(true);
    if (udid === 'booted') die(`ios: no simulator named « ${dev} » (xcrun simctl list devices)`);
    await xcrun(['simctl', 'boot', udid]);
    await run('open', ['-a', 'Simulator']);
    await iosFreezeStatusBar();
    if (reinstall || !(await installed('ios', bundle))) {
      if (artifact && isDir(artifact) && (await xcrun(['simctl', 'install', udid, artifact])).code === 0) say(`ios: ${bundle} installed on ${dev} (from ${artifact})`);
      else if (kind === 'native') say(`ios: no ${bundle} on ${dev} — set VYSU_IOS_APP_PATH (a .app built for iphonesimulator), or vysu up ios --build`);
      else say(`ios: no dev-client on ${dev} (vysu up ios --build)`);
    } else if (kind === 'native') say(`ios: ${bundle} already installed on ${dev}`);
    if (kind === 'expo') {
      if (await installed('ios', bundle)) await quietDevMenu('ios', bundle);
      say(`ios: Metro on ${port}, ${dev} booted → vysu ios open "${config().get('IOS_APP')}" --foreground`);
    } else {
      await applogStart('ios');
      say(`ios: ${dev} booted → vysu ios open "${config().get('IOS_APP')}" --foreground`);
    }
  }
  // The device is pointed at the isolated Metro now, and proves it: the relaunch waits for that
  // Metro's own « Bundled » line.
  if (isolated) await mrelaunch(p, []);
}

// `vysu down metro`: this owner's isolated Metro, or the shared one when this owner started it.
// `vysu down applog [ios|android]`: the log tails vysu started, the native app's and each device's
// JS console; no platform named, both.
export async function mobileDown(what: string, args: string[]): Promise<void> {
  if (what === 'metro') return metroDown();
  if (what === 'applog') {
    const ps = (args.length ? args : ['ios', 'android']) as Platform[];
    applogStop(ps);
    return;
  }
  die(`vysu down: ${what} is not a mobile target`);
}

