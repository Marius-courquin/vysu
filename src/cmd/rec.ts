// `vysu rec <persona> <name> [--fps 30] [--viewport 1440x900] [--mp4] [--cursor] [--flow <file>] --
// "<step>" …`: record the page while the steps run, then read the clip back as text. The motion
// report names the frames that move and the rows that flash for three frames only; agent-browser's
// contact sheet holds the distinct states the page went through; `frames/` keeps the frames the
// report names. What no screenshot catches — a transition, a scroll, a handoff — lives here.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die, exit, onCleanup } from '../core/errors.ts';
import { lockTake, resourceOf } from '../core/hold.ts';
import { which } from '../core/host.ts';
import { clipNormalize, evLog, evStart, evStep, evStop, now } from '../core/rec.ts';
import { tool } from '../img/tools.ts';
import { ab, lastLine } from '../web/ab.ts';
import { isFile, readLines } from '../web/lines.ts';
import { webLangInit, webMeta, webStep } from '../web/page.ts';
import { optValue, wh } from '../web/shots.ts';

const USAGE = 'usage: vysu rec <persona> <name> [--fps 30] [--viewport 1440x900] [--mp4] [--cursor] [--flow <file>] -- "<step>" …';

const size = (p: string): number => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

export async function run(args: string[]): Promise<void> {
  const [persona, name] = args;
  if (!persona || !name) die(USAGE);
  let fps = '30';
  let viewport = '1440x900';
  let ext = 'webm';
  let cursor = false;
  let flow = '';
  let steps: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--fps') fps = optValue(args, i++, 'rec');
    else if (a === '--viewport') viewport = optValue(args, i++, 'rec');
    // Kept for the flows that still pass it: the take is normalized to web.mp4 either way.
    else if (a === '--mp4') ext = 'mp4';
    else if (a === '--cursor') cursor = true;
    else if (a === '--flow') flow = optValue(args, i++, 'rec');
    else if (a === '--') {
      steps = args.slice(i + 1);
      break;
    } else die(`vysu rec: unknown option ${a} (steps go after --)`);
  }
  if (flow) {
    if (flow !== '-' && !isFile(flow)) die(`no flow file ${flow}`);
    steps = readLines(flow);
  }
  if (!steps.length) die(`vysu rec: no step after -- (e.g. "go ${config().get('ORIGIN')}/" "sleep 1"), or --flow <file>`);
  if (!which('ffmpeg')) die('ffmpeg missing (brew install ffmpeg)');
  const dir = join(config().shots, name);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, 'frames'), { recursive: true, force: true });
  // The last take's motion report must not be read as this one's: take re-anchors the clock on the
  // motion.txt it finds, and the web one is only written after it.
  rmSync(join(dir, 'motion.txt'), { force: true });
  const video = join(dir, `web.${ext}`);
  await lockTake(resourceOf(persona));
  await webLangInit(persona);
  const vp = await ab(persona, ['set', 'viewport', ...wh(viewport)]);
  if (vp.code !== 0) exit(vp.code);
  // Capture starts on the page already open — no cold hydration in the first frames — so a recording
  // that wants a fresh page opens it itself, as its first step.
  const start = await ab(persona, ['record', 'start', video, '--fps', fps, ...(cursor ? ['--cursor'] : []), '--contact-sheet']);
  if (start.code !== 0) exit(start.code);
  // A step that ends vysu (a shot without a label, an i18n key that does not exist) must not leave
  // the recorder running for good: the next take would find it busy.
  const disarm = onCleanup(async () => void (await ab(persona, ['record', 'stop'], { stderr: 'drop' })));
  const rows = join(dir, 'events.jsonl');
  writeFileSync(rows, '');
  evStart(rows);
  const print = (s: string): void => void process.stdout.write(s);
  for (const step of steps) {
    print(`▸ ${step}\n`);
    evStep();
    const t0 = now();
    // A failed step must not leave ffmpeg recording for good: the clip is stopped either way.
    const ok = await webStep(persona, name, step, print);
    if (!ok) process.stderr.write(`vysu rec: step failed: ${step}\n`);
    evLog(step, t0, now(), ok);
  }
  // `record stop` fails on its own now and then — a contact-sheet analyzer falling behind a heavy
  // page drops the whole take — so what it said is worth more than a bare non-zero exit. Anchored on
  // the moment the last frame is asked for: the take is anchored on its end (see src/img/take.ts).
  const tStop = now();
  const stop = await ab(persona, ['record', 'stop'], { stderr: 'capture' });
  disarm();
  const stopped = `${stop.stdout}${stop.stderr}`.replace(/\n+$/, '');
  if (!(size(video) > 0)) die(`vysu rec: no video written — ${lastLine(stopped)}`);
  if (stop.code !== 0) process.stderr.write(stopped.split('\n').map((l) => `vysu rec: ${l}\n`).join(''));
  const clip = join(dir, 'web.mp4');
  await clipNormalize(clip, video, Number(fps));
  print(`${clip}\n`);
  // agent-browser writes the contact sheet next to the video, under the same stem.
  if (existsSync(join(dir, 'web.contact-sheet.png'))) print(`${join(dir, 'web.contact-sheet.png')}\n`);
  const take = await tool('take', ['events', '--dir', dir, '--rows', rows, '--clip', 'web.mp4', '--kind', 'web', '--platform', 'web', '--t-stop', tStop, '--viewport', viewport]);
  print(take.stdout);
  process.stderr.write(take.stderr);
  if (take.code !== 0) exit(take.code);
  rmSync(rows, { force: true });
  evStop();
  await webMeta(dir, persona, { viewport, fps, events: 'true', clip: 'web.mp4' });
  const motion = await tool('motion', [clip, '--fps', fps, '--scale', '1', '--dump', join(dir, 'frames')]);
  print(motion.stdout);
  writeFileSync(join(dir, 'motion.txt'), motion.stdout);
  process.stderr.write(motion.stderr);
  if (motion.code !== 0) exit(motion.code);
}
