// What vysu last applied to a device: a mobile capture records it, and `tap t:<key>` reads the
// language back from it. Per device, like the scale cache: two emulators run side by side, and a
// `mrelaunch android --lang en` on one of them used to make `tap t:common.close` look for the
// English label on the other, still in the first language.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { devices, owner, type Platform } from '../core/hold.ts';
import { listening } from '../core/net.ts';
import { hhmm, nowSeconds, slug } from '../core/text.ts';

export function mstateFile(p: Platform, device = devices.of(p)): string {
  return join(config().state, `state-${p}-${slug(device)}.env`);
}

function readLines(f: string): string[] {
  try {
    return readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');
  } catch {
    return [];
  }
}

// A key that is not there is an answer, not a failure: the last line of that key wins.
export function mstateField(f: string, key: string): string {
  let v = '';
  for (const l of readLines(f)) if (l.startsWith(`${key}=`)) v = l.slice(key.length + 1);
  return v;
}

// Every setter goes through here, so every write also says who made it and when: the next agent
// reads « by codex:5120 at 14:52 » in `vysu claim` instead of wondering whose device it just took.
export function mstateSet(p: Platform, key: string, value: string): void {
  const f = mstateFile(p);
  mkdirSync(config().state, { recursive: true });
  const kept = readLines(f).filter((l) => !l.startsWith(`${key}=`) && !l.startsWith('by=') && !l.startsWith('at='));
  writeFileSync(`${f}.tmp`, `${[...kept, `${key}=${value}`, `by=${owner()}`, `at=${nowSeconds()}`].join('\n')}\n`);
  renameSync(`${f}.tmp`, f);
}

export function mstateGet(p: Platform, key: string, fallback = ''): string {
  return mstateField(mstateFile(p), key) || fallback;
}

// « state: … », only the keys that are set. `net`: `vysu mnet` cut the network (airplane mode),
// which `release --reset` turns back on. Metro is an expo notion: a native app has no bundler behind
// the screen to name. Whose isolated Metro it is, when it is one, and whether it still answers: a
// device bound to a stopped Metro shows the last screen it had, which is not the branch it claims to
// show.
export async function mstateLine(f: string, device = '', expo = true): Promise<string> {
  const parts: string[] = [];
  for (const k of ['textsize', 'appearance', 'lang', 'persona', 'net']) {
    const v = mstateField(f, k);
    if (v) parts.push(`${k} ${v}`);
  }
  if (expo) {
    const v = mstateField(f, 'metro');
    if (v) {
      const iso = mstateField(f, 'metro_isolated');
      let m = `metro ${v.replace(/^localhost/, '')}${iso ? ` (isolated, ${iso})` : ''}`;
      if (!(await listening(Number(v.slice(v.lastIndexOf(':') + 1))))) m += ' (not running)';
      parts.push(m);
    }
  }
  let out = parts.join(' · ');
  const by = mstateField(f, 'by');
  if (by) out += `${out ? ' · ' : ''}by ${by}`;
  const at = mstateField(f, 'at');
  if (at) out += ` at ${hhmm(Number(at))}`;
  return `state${device ? ` ${device}` : ''}: ${out || '(no state recorded)'}`;
}

// The mrelaunch flags that put a device back to the defaults, or ''. A --lang costs a zygote restart
// on Android: only asked for when it is not already the default.
export function mresetArgs(p: Platform): string {
  let out = '';
  if (mstateGet(p, 'textsize', 'normal') !== 'normal') out += ' --textsize normal';
  if (mstateGet(p, 'appearance', 'light') !== 'light') out += ' --appearance light';
  const lang = config().get('LANG');
  if (lang && mstateGet(p, 'lang', lang) !== lang) out += ` --lang ${lang}`;
  return out;
}
