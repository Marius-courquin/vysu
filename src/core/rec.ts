// What a recording knows about its own steps: when each one ran, whether it worked, and where it
// landed. One raw row per step while the take runs — take turns them into events.json at the end,
// once the clip's duration says where its first frame was. An empty `rows` = not recording, so
// `vysu flow` and `vysu mflow` pay nothing and write nothing.
import { appendFileSync, renameSync, rmSync } from 'node:fs';
import { run } from './proc.ts';
import { config } from './ctx.ts';
import { die } from './errors.ts';

export const ev = {
  rows: '',
  i: 0,
  // « x y » (a device press) or « x y w h » (a web box), set by the step that acted.
  target: '',
  // The label a « t:<i18n.key> » step resolved to, which the raw line no longer holds.
  label: '',
  // The clock when the step's first touch was sent: a tap reads the screen before it presses.
  at: '',
};

export function evStart(rowsFile: string): void {
  ev.rows = rowsFile;
  ev.i = 0;
  evStep();
}

// What a step knows is its own: cleared before each one.
export function evStep(): void {
  ev.target = '';
  ev.label = '';
  ev.at = '';
}

export function evStop(): void {
  ev.rows = '';
}

// Seconds since the epoch to the millisecond, the clock every row is written in.
export const now = (): string => (Date.now() / 1000).toFixed(3);

// The instant a step touches the screen: each press, click or fill it sends overwrites it, so a search
// that tries a label, then a text, then a point keeps the attempt that landed. Typing into a field
// already focused is not a touch.
export function evTouch(): void {
  if (ev.rows) ev.at = now();
}

// A recorded take types at a person's pace (img/pace.ts): a field that fills in a blink reads as a
// paste on screen. Everything else fills at once. VYSU_TYPING says otherwise: `fast` for a take that
// must not wait, `human` for a flow someone watches live.
export function typingHuman(): boolean {
  const how = config().get('TYPING');
  if (how === 'fast') return false;
  if (how === 'human') return true;
  return ev.rows !== '';
}

export function evRow(line: string, start: string, end: string, ok: boolean): string {
  const text = line.replace(/[\t\n]/g, ' ');
  return `${ev.i}\t${start}\t${end}\t${ok}\t${ev.target}\t${ev.label}\t${text}\t${ev.at}\n`;
}

export function evLog(line: string, start: string, end: string, ok: boolean): void {
  if (!ev.rows) return;
  ev.i++;
  appendFileSync(ev.rows, evRow(line, start, end, ok));
}

// One transcode at the end of a take, so every consumer reads the same clip: H.264 yuv420p (what
// Remotion, QuickTime and a browser all play), faststart, a keyframe every second — seeking one frame
// otherwise decodes a whole GOP — and even dimensions, which yuv420p requires. Constant frame rate:
// simctl and screenrecord only emit a frame when the screen changes (a 19 s take came back as 106
// frames on a 600 timebase), so a mobile clip has no native cadence to keep; resampling to a fixed
// rate makes second N frame N × fps, which is what Remotion trims on.
export async function clipNormalize(out: string, src: string, fps: number): Promise<void> {
  const tmp = `${out}.norm.mp4`;
  const r = await run('ffmpeg', [
    '-nostdin', '-y', '-i', src, '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-fps_mode', 'cfr', '-g', String(fps), '-movflags', '+faststart',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', tmp,
  ]);
  if (r.code !== 0) {
    rmSync(tmp, { force: true });
    die(`ffmpeg: ${(r.stderr.trim().split('\n').pop() ?? '').trim()}`);
  }
  if (src !== out) rmSync(src, { force: true });
  renameSync(tmp, out);
}
