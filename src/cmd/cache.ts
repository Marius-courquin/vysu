// `vysu cache clear`: forget what is remembered per device — simulator UDIDs, emulator serials,
// scales, and the text size / appearance / language applied.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';

const PREFIXES = ['ios-udid-', 'android-serial-', 'scale-', 'state-'];

export async function run(args: string[]): Promise<void> {
  if (args[0] !== 'clear') die('usage: vysu cache clear');
  const state = config().state;
  let names: string[] = [];
  try {
    names = readdirSync(state);
  } catch {
    // no state folder: nothing remembered
  }
  let n = 0;
  for (const prefix of PREFIXES) {
    for (const f of names.filter((x) => x.startsWith(prefix)).sort()) {
      const p = join(state, f);
      try {
        if (statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      rmSync(p, { force: true });
      n++;
    }
  }
  console.log(`cache: ${n} file(s) dropped (simulator UDIDs, emulator serials, device scales, applied text size / appearance / language)`);
}
