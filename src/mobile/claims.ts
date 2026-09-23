// A lock lasts one command; a mobile task lasts twenty. A claim says « this device is mine until
// then », and every other agent's command waits on it exactly as it waits on a lock. `vysu claim`
// also reads back what the last agent left on the device; `vysu release` hands it back, in its
// defaults with --reset.
import { existsSync, rmSync } from 'node:fs';
import { config } from '../core/ctx.ts';
import { die, log } from '../core/errors.ts';
import {
  CLAIM_MINUTES,
  claimField,
  claimFile,
  claimWhy,
  claimWrite,
  deviceEnv,
  deviceGuard,
  deviceRemember,
  devices,
  iosLock,
  lockDrop,
  lockTake,
  owner,
  ownerDevices,
  resourceOf,
  type Platform,
} from '../core/hold.ts';
import { listening } from '../core/net.ts';
import { hhmm } from '../core/text.ts';
import { webClaimState, webReset } from '../web/api.ts';
import { forgetSerial } from './device.ts';
import { quiet, say } from './io.ts';
import { mobileKind, mrelaunch } from './launch.ts';
import { mnet } from './mctl.ts';
import { metroPort } from './metro.ts';
import { claimAny, deleteClone, isClone, poolIsUp, poolPower } from './pool.ts';
import { mscreenLine } from './screen.ts';
import { mresetArgs, mstateFile, mstateGet, mstateLine } from './state.ts';

export const CLAIM_USAGE = `usage: vysu claim ios|android|<persona> [--minutes ${CLAIM_MINUTES}] [--note "<why>"] · ios --device "<name>" · android --avd <name> · ios|android --any [--no-wait]`;

export async function claim(args: string[]): Promise<void> {
  const what = args[0] ?? '';
  if (!what) die(CLAIM_USAGE);
  let minutes = String(CLAIM_MINUTES);
  let note = '';
  let device = '';
  let any = false;
  let nowait = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--any') {
      any = true;
      continue;
    }
    if (a === '--no-wait') {
      nowait = true;
      continue;
    }
    if (!['--minutes', '--note', '--device', '--avd'].includes(a)) die(`vysu claim: unknown option ${a}`, CLAIM_USAGE);
    if (i + 1 >= args.length) die(`vysu claim: ${a} needs a value`);
    const v = args[++i]!;
    if (a === '--minutes') minutes = v;
    else if (a === '--note') note = v;
    else if (a === '--device') {
      if (what !== 'ios') die('vysu claim: --device names a simulator', 'vysu claim ios --device "<name>"');
      device = v;
    } else {
      if (what !== 'android') die('vysu claim: --avd names an emulator', 'vysu claim android --avd <name>');
      device = v;
    }
  }
  if (!/^[0-9]+$/.test(minutes) || minutes === '0') die(`vysu claim: --minutes is a whole number of minutes (got « ${minutes} »)`);
  if (any) {
    if (what !== 'ios' && what !== 'android') die('vysu claim: --any picks a device', 'vysu claim ios|android --any');
    if (device) die('vysu claim: --any picks the device, --device / --avd names one: not both');
    return claimAny(what, Number(minutes), note, nowait, claimReport);
  }
  if (device) {
    const p = what as Platform;
    // A device named is checked before anything is written: a typo must not become this owner's
    // device choice, and every command after it fail on a simulator that does not exist.
    if ((await poolPower(p, device)) === 'not on this machine') {
      die(`${p}: no ${p === 'ios' ? `simulator named « ${device} »` : `AVD ${device}`} on this machine`, 'vysu devices');
    }
    if (p === 'ios') devices.ios = device;
    else {
      devices.android = device;
      forgetSerial();
    }
    devices.named(p);
    const key = p === 'ios' ? 'IOS_DEVICE' : 'ANDROID_AVD';
    if (config().origin(key) === 'env') log(`VYSU_${key} is set in the environment: it still wins over this choice`);
  }
  let dev = '';
  if (what === 'ios' || what === 'android') {
    deviceGuard(what);
    dev = devices.of(what);
  }
  const r = resourceOf(what);
  await claimSeal(r, Number(minutes), note, dev);
  if (device) deviceRemember(what === 'ios' ? 'ios-device' : 'android-avd', device);
  await claimReport(what, r, '');
}

// The check and the write under the pool lock `--any` takes: two owners claiming the same device at
// the same moment both found it free, both were told « claimed », and the second file replaced the
// first. Beyond 0.5.1, which had the same gap.
export async function claimSeal(r: string, minutes: number, note: string, device: string): Promise<void> {
  const pool = `pool-${r.slice(0, r.indexOf('-'))}`;
  await lockTake(pool);
  try {
    const held = claimWhy(r);
    if (held) die(`${r} ${held}`);
    claimWrite(r, minutes, note, device);
  } finally {
    lockDrop(pool);
  }
}

// What a claim prints: the claim itself, then what the last agent left on the device. The lines a
// skill reads (`state:`, `screen:`, `reset:`) keep their names and their order.
export async function claimReport(what: string, r: string, done: string): Promise<void> {
  const f = claimFile(r);
  const until = hhmm(Number(claimField(f, 'until') || 0));
  const who = claimField(f, 'owner');
  if (r.startsWith('ios-') || r.startsWith('android-')) {
    const p = r.slice(0, r.indexOf('-')) as Platform;
    const dev = devices.of(p);
    if (what === p) {
      // From the second device of a platform on, a command that names none is refused: the claim says
      // so, and hands the prefix, before the first refusal does.
      const n = ownerDevices(p).length;
      const name = n >= 2 ? `${deviceEnv(p, dev)} ` : '';
      say(`claimed: ${p} « ${dev} » until ${until} by ${who} (${name}vysu release ${p})`);
      if (name) say(`name it: ${who} holds ${n} ${p} devices, so every command names its own: ${name}vysu …`);
    } else {
      say(`claimed: ${r} until ${until} by ${who} (vysu release ${what})`);
    }
    const power = await poolPower(p);
    if (done) say(`device: ${done}`);
    else if (!poolIsUp(power)) say(`device: ${power} (${p === 'ios' ? 'vysu up ios boots it' : 'vysu up android starts it'})`);
    say(await mstateLine(mstateFile(p), '', mobileKind() === 'expo'));
    // No snapshot of a device that is not up: agent-device would boot it to answer.
    say(poolIsUp(power) ? await mscreenLine(p) : `screen: (${power})`);
    const args = mresetArgs(p);
    if (args) say(`reset: vysu mrelaunch ${p}${args}`);
    return;
  }
  // A web session carries its own login and its own URL: there is nothing vysu has to remember for
  // it, so the state is read from the browser rather than from a file.
  say(`claimed: ${r} until ${until} by ${who} (vysu release ${what})`);
  say(await webClaimState(what));
}

export const RELEASE_USAGE = 'usage: vysu release ios|android|<persona> [--force] [--reset] [--delete-clone]';

export async function release(args: string[]): Promise<void> {
  const what = args[0] ?? '';
  if (!what) die(RELEASE_USAGE);
  let force = false;
  let reset = false;
  let del = false;
  for (const a of args.slice(1)) {
    if (a === '--force') force = true;
    else if (a === '--reset') reset = true;
    else if (a === '--delete-clone') del = true;
    else die(`vysu release: unknown option ${a}`);
  }
  // Which of two devices « android » means is the question a sibling's release would answer wrong.
  if (what === 'ios' || what === 'android') deviceGuard(what);
  const r = resourceOf(what);
  const f = claimFile(r);
  if (del) {
    // Only a clone vysu made, and only by the owner holding it: a simulator somebody made by hand, or
    // one another session is driving, is never deleted from here.
    if (what !== 'ios') die('vysu release: --delete-clone is for an iOS clone', 'vysu release ios --delete-clone');
    if (!isClone(devices.ios)) die(`« ${devices.ios} » is not a vysu clone: only a « <name> (vysu N) » simulator is deleted`);
    if (!existsSync(f) || claimField(f, 'owner') !== owner()) {
      die(`--delete-clone deletes a clone this owner holds, and ${owner()} holds no claim on « ${devices.ios} »`, `vysu claim ios --device "${devices.ios}"`);
    }
  }
  if (!existsSync(f)) {
    say(`release: no claim on ${r}`);
    return;
  }
  const who = claimField(f, 'owner');
  if (who !== owner() && !force) die(`${r} is claimed by ${who} (vysu release ${what} --force to take it over)`);
  // Handing a device back the way it was found: the next agent's `vysu claim` then reads a device in
  // its defaults instead of a large-text dark one it has to notice before believing a capture. A clone
  // about to be deleted has nobody to hand it back to.
  if (del) {
    await iosLock();
    await deleteClone(devices.ios);
  } else if (reset) {
    // Another owner's claim is taken over first: the reset relaunches under the device's lock, which
    // waits on any other owner's claim, and died on the very claim being released. Should the reset
    // die, the claim is this owner's, which a plain `vysu release` hands back.
    if (who !== owner()) claimWrite(r, Number(claimField(f, 'minutes')) || CLAIM_MINUTES, claimField(f, 'note'), claimField(f, 'device'));
    await resetResource(r, what);
  }
  rmSync(f, { force: true });
  say(`released: ${r} (was ${who})`);
}

// Back to the defaults, only what differs from them. A persona goes by the name it was typed with: the
// resource is a slug of it, and a slug is not a session name.
export async function resetResource(r: string, what = r.replace(/^web-/, '')): Promise<void> {
  if (r.startsWith('ios-') || r.startsWith('android-')) {
    const p = r.slice(0, r.indexOf('-')) as Platform;
    // The network first: it needs no relaunch, and a device handed back offline fails the next agent's
    // every request before it thinks of looking at airplane mode.
    if (mstateGet(p, 'net') === 'offline' && (await quiet(() => mnet(p, ['online'])))) say(`reset: ${p} back online`);
    const args = mresetArgs(p);
    if (!args) {
      say(`reset: ${p} already in its defaults`);
      return;
    }
    // A relaunch on a device that is not up would fail halfway, or boot it: it is reset on its next
    // `vysu up`, when the claim that follows prints the same `reset:` line.
    const power = await poolPower(p);
    if (!poolIsUp(power)) {
      say(`reset: ${p} left as it is (${power})`);
      return;
    }
    if (mobileKind() === 'expo' && !(await listening(Number(metroPort())))) {
      say(`reset: ${p} left as it is — Metro is not running (vysu up ${p})`);
      return;
    }
    await quiet(() => mrelaunch(p, args.trim().split(' ')));
    say(`reset: vysu mrelaunch ${p}${args}`);
    return;
  }
  if (r.startsWith('web-')) say(await webReset(what));
}
