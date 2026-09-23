// Record the screen while steps run, then read the video back as text: which frames move, and which
// rows flash for a few frames only — a hairline at a seam, a control that blinks — the things no
// screenshot catches (a 60 fps read finds a 3-frame line; agent-device's captures never will). The
// frames are streamed out of ffmpeg, not written: only the ones the report names land in
// `<name>/frames/` (`--crop x,y,w,h` in points narrows the scan).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { CLIP_FPS } from '../core/config.ts';
import { die, exit, onCleanup } from '../core/errors.ts';
import { which } from '../core/host.ts';
import { devices, type Platform } from '../core/hold.ts';
import { metaWrite, repoSha } from '../core/meta.ts';
import { clipNormalize, evLog, evStart, evStep, evStop, now } from '../core/rec.ts';
import { sleep } from '../core/text.ts';
import { tool } from '../img/tools.ts';
import { adb, androidSelect, iosUdid, mobileScale, serial } from './device.ts';
import { say, tell } from './io.ts';
import { mobileStep } from './steps.ts';
import { mstateGet } from './state.ts';
import { adbPath } from './tools.ts';

export const MREC_USAGE = 'usage: vysu mrec ios|android <name> [--fps 60] [--crop x,y,w,h] -- "<step>" …';

// Points → pixels, in ffmpeg's order: w:h:x:y.
export function cropPixels(crop: string, scale: string): string {
  const [x = 0, y = 0, w = 0, h = 0] = crop.split(',').map(Number);
  const s = Number(scale);
  return [w * s, h * s, x * s, y * s].map((v) => String(Math.trunc(v))).join(':');
}

const exited = (c: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once('close', () => resolve());
  });

export async function mrec(argv: string[]): Promise<number> {
  const [p = '', name = ''] = argv;
  if (!p || !name) die(MREC_USAGE);
  let fps = '60';
  let crop = '';
  let steps: string[] = [];
  let sawSteps = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--fps') fps = argv[++i] ?? '';
    else if (a === '--crop') crop = argv[++i] ?? '';
    else if (a === '--') {
      steps = argv.slice(i + 1);
      sawSteps = true;
      break;
    } else die(`vysu mrec: unknown option ${a} (steps go after --)`);
  }
  if (!sawSteps || !steps.length) die('vysu mrec: no step after -- (e.g. "press 173 822" "sleep 1.5")');
  const platform = p as Platform;
  if (platform === 'android') await androidSelect();
  if (!which('ffmpeg')) die('ffmpeg missing (brew install ffmpeg)');
  const dir = join(config().shots, name);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, 'frames'), { recursive: true, force: true });
  const video = join(dir, `${platform}.mp4`);
  const scale = await mobileScale(platform);
  mkdirSync(config().logs, { recursive: true });
  // A screen recording must not outlive vysu: between the start and the stop any die — a lock given
  // up, an i18n key that does not exist — would leave `screenrecord` filling /sdcard or simctl holding
  // a half-written mp4, and the next `vysu mrec` would record on top of it. The recorder in flight is
  // stopped whichever way vysu ends.
  let child: ChildProcess;
  if (platform === 'android') {
    child = spawn(adbPath(), ['-s', serial.value, 'shell', 'screenrecord', '--bit-rate', '8000000', '--time-limit', '180', '/sdcard/vysu-rec.mp4'], { stdio: 'ignore' });
  } else {
    const log = openSync(join(config().logs, 'mrec.log'), 'w');
    child = spawn('xcrun', ['simctl', 'io', await iosUdid(), 'recordVideo', '--codec', 'h264', '--force', video], { stdio: ['ignore', log, log] });
    closeSync(log);
  }
  child.on('error', () => undefined);
  let stopped = false;
  const recStop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (platform === 'android') await adb(['shell', 'pkill', '-INT', 'screenrecord']);
    else child.kill('SIGINT');
    await exited(child);
  };
  const forget = onCleanup(recStop);
  await sleep(3000);
  const rows = join(dir, 'events.jsonl');
  writeFileSync(rows, '');
  evStart(rows);
  for (const step of steps) {
    say(`▸ ${step}`);
    evStep();
    const t0 = now();
    // A step that fails — a label that is not on screen — is worth saying, not worth losing the take
    // for: the rest is played, and the clip is read back as usual.
    const ok = await mobileStep(platform, name, step);
    if (!ok) tell(`vysu mrec: step failed: ${step}`);
    evLog(step, t0, now(), ok);
  }
  await sleep(1000);
  // The instant the last frame is asked for, not the one the recorder finishes writing: simctl and
  // screenrecord take a few hundred ms to close the file, and the take is anchored on its end.
  const tStop = now();
  await recStop();
  forget();
  if (platform === 'android') {
    await sleep(2000); // screenrecord closes the file after its SIGINT; pulling it earlier gets a truncated one
    if ((await adb(['pull', '/sdcard/vysu-rec.mp4', video])).code === 0) await adb(['shell', 'rm', '/sdcard/vysu-rec.mp4']);
  }
  let size = 0;
  try {
    size = statSync(video).size;
  } catch {
    size = 0;
  }
  if (!size) die(`vysu mrec: no video written (see ${join(config().logs, 'mrec.log')})`);
  const args = ['--fps', fps, '--scale', scale, '--dump', join(dir, 'frames')];
  if (crop) args.push('--crop', cropPixels(crop, scale));
  say(video);
  // The motion report reads the RAW take, at its own --fps: the recorder stamps each frame at the
  // instant the screen changed, which is what finds a three-frame hairline. The clip is normalized
  // only afterwards, to the rate the montage renders at, and that is what events.json describes.
  const motion = await tool('motion', [video, ...args]);
  writeFileSync(join(dir, 'motion.txt'), motion.stdout);
  if (motion.stdout) process.stdout.write(motion.stdout);
  if (motion.stderr) process.stderr.write(motion.stderr);
  if (motion.code !== 0) exit(motion.code);
  await clipNormalize(video, video, CLIP_FPS);
  const take = await tool('take', ['events', '--dir', dir, '--rows', rows, '--clip', `${platform}.mp4`, '--kind', 'mobile', '--platform', platform, '--t-stop', tStop, '--scale', scale]);
  if (take.stdout) process.stdout.write(take.stdout);
  if (take.stderr) process.stderr.write(take.stderr);
  if (take.code !== 0) exit(take.code);
  rmSync(rows, { force: true });
  evStop();
  metaWrite(dir, {
    kind: 'mobile',
    platform,
    device: devices.of(platform),
    events: 'true',
    clip: `${platform}.mp4`,
    lang: mstateGet(platform, 'lang', config().get('LANG')),
    textsize: mstateGet(platform, 'textsize', 'normal'),
    mobile_sha: repoSha(config().mobileDir || config().projectDir),
  });
  return 0;
}
