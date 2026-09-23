// What a shots folder holds, in one file: `vysu report` reads it back instead of guessing from the
// file names, and a capture two weeks old still says which branch and which API it came from.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './ctx.ts';
import { isoLocal } from './text.ts';

export type Meta = Record<string, unknown>;

export function metaRead(dir: string): Meta {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

// key=value pairs, or values already typed. A string that parses as JSON (a list, an object, a
// boolean, null) is stored as JSON: that is how a caller passes a list through a key=value pair.
export function metaWrite(dir: string, values: Record<string, unknown>): void {
  const meta = metaRead(dir);
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{') || ['true', 'false', 'null'].includes(v))) {
      try {
        meta[k] = JSON.parse(v);
        continue;
      } catch {
        // kept as the string it is
      }
    }
    meta[k] = v;
  }
  meta.date = isoLocal();
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
}

// The git checkout a capture is attributed to: the project's web or mobile folder when the config
// names one, the project itself otherwise.
function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-C', dir || config().projectDir || '.', ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}
export const repoSha = (dir = ''): string => git(dir, ['rev-parse', '--short', 'HEAD']);
export const repoBranch = (dir = ''): string => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
