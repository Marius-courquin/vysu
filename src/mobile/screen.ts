// One step, then what the screen shows: that is how an agent drives a device without a press, a
// sleep, a snapshot and a grep per action. Everything below reads agent-device's own snapshot
// (`snapshot -i --json`) through the screen helper, one file per device (and its .keys, .said beside
// it): the device is locked by the command writing them, so there is never a second writer, and
// each command overwrites what the last one left instead of piling up temp files.
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { devices, type Platform } from '../core/hold.ts';
import { slug } from '../core/text.ts';
import { nearWords, readSnapshot, screenNear, type Near } from '../img/screen.ts';
import { tool } from '../img/tools.ts';
import { adCall, answerJson, calls } from './agent.ts';
import { androidSerial, mobileScale } from './device.ts';
import { sessionOpen } from './launch.ts';
import { anrWait, nodesOf } from './snap.ts';

export function snapFile(p: Platform): string {
  return join(config().state, `.snap-${p}-${slug(devices.of(p))}.json`);
}

// Set by a verb whose last snapshot is the screen after it: the runner then reads that one instead of
// asking for another (a wait, an expect, a scroll-to each end on a fresh one).
export const snapState = { fresh: false };

const nonEmpty = (f: string): boolean => {
  try {
    return statSync(f).size > 0;
  } catch {
    return false;
  }
};

// A fresh snapshot of the device into its file; false when agent-device answered nothing readable
// (the file is then emptied, so no reader mistakes the previous screen for this one). Asked twice: a
// capture now and then comes back unreadable on a screen that is fine, and « nothing readable » after
// a step would send the agent looking for a problem that is not there.
export async function msnap(p: Platform): Promise<boolean> {
  const f = snapFile(p);
  mkdirSync(config().state, { recursive: true });
  for (let i = 0; i < 2; i++) {
    const a = await adCall(p, calls.snapshot({ interactive: true, timeoutMs: 10000 }));
    writeFileSync(f, answerJson(a));
    if (a.ok && Array.isArray(a.data.nodes)) return true;
  }
  writeFileSync(f, '');
  return false;
}

export async function screenPy(args: string[]): Promise<{ code: number; out: string }> {
  const r = await tool('screen', args);
  return { code: r.code, out: r.stdout };
}

// `agent-device keyboard status` answers on Android only, where the IME is not in the app's tree; iOS
// lays its keyboard out in the tree, and the screen helper reads it there.
async function keyboardUp(p: Platform): Promise<boolean> {
  if (p !== 'android') return false;
  const a = await adCall(p, calls.keyboard('status'));
  if (!a.ok) return false;
  const d = a.data;
  return !!(d.visible || d.keyboardVisible || d.shown);
}

// « screen: <≤ 6 labels> (<n> nodes, +added −removed, keyboard, focus "<field>") » — the delta is
// against the previous line printed for this device, so the first one of a command starts from
// mscreenReset. `fresh` reuses the snapshot a verb has just taken.
export async function mscreen(p: Platform, fresh = false): Promise<string> {
  const f = snapFile(p);
  if (!(fresh && nonEmpty(f))) await msnap(p);
  let kb = 'auto';
  let scale = '1';
  // The keyboard is only worth a question when there is something on screen to type into. An
  // Android snapshot measures in pixels: the icon size is judged in dp, like on iOS in points.
  if (p === 'android') {
    kb = 'no';
    scale = await mobileScale('android');
    if ((await screenPy(['editable', f])).code === 0 && (await keyboardUp(p))) kb = 'yes';
  }
  const line = (await screenPy(['line', f, '--prev', `${f}.keys`, '--save', `${f}.keys`, '--keyboard', kb, '--scale', scale])).out.replace(/\n$/, '');
  // An ANR dialog is the one system dialog that says nothing of itself but its two buttons: named, so
  // the agent reads « the app is not responding » rather than a screen of two words.
  if (p === 'android' && anrWait(nodesOf(readSnapshot(f).data))) return `${line} · ANR dialog: an app is not responding (vysu mdo answers « Attendre » on a failed step; or tap "Attendre")`;
  return line;
}

// Where a text a step did not find is, in the words the step's ✗ line ends on (img/screen.ts): the
// snapshot the step just took when it has one, else a fresh one.
export async function mnearOf(p: Platform, text: string, fresh = false): Promise<Near | null> {
  const f = snapFile(p);
  if (!(fresh && nonEmpty(f)) && !(await msnap(p))) return null;
  const scale = p === 'android' ? Number(await mobileScale('android')) || 1 : 1;
  return screenNear(readSnapshot(f), text, scale);
}
export async function mnear(p: Platform, text: string, fresh = false): Promise<string> {
  return nearWords(await mnearOf(p, text, fresh), undefined, !screenFollows.on);
}
// Set while `mdo` or `mwait` runs a step: they print the screen line after a failure themselves, and
// a miss then only adds what that line cannot say (covered, off the screen, what reads like it).
export const screenFollows = { on: false };
// « <what> · <where> », or <what> alone when there is nothing to add.
export const withNear = (what: string, near: string): string => (near ? `${what} · ${near}` : what);

// The baseline the next line's delta is counted from.
export async function mscreenReset(p: Platform): Promise<void> {
  const f = snapFile(p);
  rmSync(`${f}.keys`, { force: true });
  await msnap(p);
  await screenPy(['line', f, '--save', `${f}.keys`]);
}

// What the device is showing, without asking for the tree twice: the labels agent-device already
// answers with, deduplicated and cut at six — enough to name the screen, cheap enough to print on
// every claim. Only for a session that is already open: opening one costs a minute of runner build.
export async function mscreenLine(p: Platform): Promise<string> {
  if (!(await sessionOpen(p))) return `screen: (no session — vysu ${p} open …)`;
  if (p === 'android' && !(await androidSerial())) return 'screen: (emulator not running)';
  const a = await adCall(p, calls.snapshot({ interactive: true, timeoutMs: 20000 }));
  const nodes = (a.ok && Array.isArray(a.data.nodes) ? a.data.nodes : []) as Array<{ type?: string; label?: string }>;
  const seen: string[] = [];
  for (const n of nodes) {
    // The root node is the app itself, not something on screen.
    if (n.type === 'Application') continue;
    const label = (n.label ?? '').trim();
    if (label.length < 3 || seen.includes(label)) continue;
    seen.push(label);
    if (seen.length === 6) break;
  }
  return `screen: ${seen.join(' · ') || '(nothing readable)'}`;
}

