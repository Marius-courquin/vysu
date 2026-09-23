// What a shots folder holds, in one file: `vysu report` reads it back instead of guessing from the
// file names, and a capture two weeks old still says which branch and which API it came from.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './ctx.ts';
import { pidAlive } from './host.ts';
import { isoLocal, sleep } from './text.ts';

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
export function metaWrite(dir: string, values: Record<string, unknown>): Promise<void> {
  return withMetaLock(dir, () => metaWriteNow(dir, values));
}

function metaWriteNow(dir: string, values: Record<string, unknown>): void {
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
  // Through a temporary file: a reader never sees half of it.
  const tmp = join(dir, `.meta.json.${process.pid}.${nextTmp()}.tmp`);
  writeFileSync(tmp, JSON.stringify(meta, null, 1));
  renameSync(tmp, join(dir, 'meta.json'));
}

// The git checkout a capture is attributed to: the project's web or mobile folder when the config
// names one, the project itself otherwise.
function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-C', dir || config().projectDir || '.', ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}
export const repoSha = (dir = ''): string => git(dir, ['rev-parse', '--short', 'HEAD']);
export const repoBranch = (dir = ''): string => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

// A turn each at a folder's meta.json: two mshots into one folder (an iPhone and an Android at once)
// each read it, changed it and wrote it back, and one verdict was lost, or the rename found the
// other's temporary file already gone. The lock is a directory beside it holding its pid, taken by
// mkdir; one whose process is gone, or older than a read-modify-write could ever take, is taken over.
const STALE_MS = 5000;
let tmpSeq = 0;
export const nextTmp = (): number => ++tmpSeq;

function lockHolder(lock: string): { pid: number; age: number } | null {
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    let pid = 0;
    try {
      pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim()) || 0;
    } catch {
      pid = 0;
    }
    return { pid, age };
  } catch {
    return null;
  }
}

export async function withMetaLock<T>(dir: string, fn: () => T): Promise<T> {
  const lock = join(dir, '.meta.json.lock');
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const h = lockHolder(lock);
    if (h && (h.age > STALE_MS || (h.pid && !pidAlive(h.pid)))) rmSync(lock, { recursive: true, force: true });
    else await sleep(10);
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
