// What differs from one operating system to the next, and nothing else: the process table (who
// drives vysu), which process listens on a port, how a file is opened for a human, where a tool is.
// Everything above this file is the same code on macOS, Linux and Windows.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { connect } from 'node:net';
import { parseNetstatListeners, parseProcessLines, windowsProcessLines } from './winps.ts';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
// WSL is Linux for everything but two things: the Android emulator and the browser a human opens
// run on the Windows side.
export const isWsl = isLinux && (!!process.env.WSL_DISTRO_NAME || safeRead('/proc/sys/kernel/osrelease').toLowerCase().includes('microsoft'));

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export interface Proc {
  ppid: number;
  name: string;
}

// A process name the way `ps -o comm=` gives it, reduced to what an owner is called by: the last
// path component, spaces as dashes, and on Windows without the `.exe`.
export function procName(raw: string): string {
  let n = raw.trim().replace(/.*[/\\]/, '');
  if (isWindows) n = n.replace(/\.exe$/i, '');
  return n.replaceAll(' ', '-');
}

let table: Map<number, Proc> | undefined;

// The whole table in one read: walking up the tree one `ps` at a time cost a process per level.
export function processTable(): Map<number, Proc> {
  if (table) return table;
  table = new Map();
  if (isLinux) {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const stat = safeRead(`/proc/${d}/stat`);
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const ppid = Number(stat.slice(close + 2).split(' ')[1]);
      table.set(Number(d), { ppid, name: procName(name) });
    }
  } else if (isWindows) {
    for (const p of parseProcessLines(windowsProcessLines())) table.set(p.pid, { ppid: p.ppid, name: procName(p.name) });
  } else {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: procName(m[3]!) });
    }
  }
  return table;
}

// One process, fresh: whether it still exists and what it runs now (a pid handed to another program
// since counts as someone else).
export function processName(pid: number): string {
  if (!(pid > 0)) return '';
  if (isLinux) {
    const comm = safeRead(`/proc/${pid}/comm`);
    return comm ? procName(comm) : '';
  }
  if (isWindows) {
    const hit = parseProcessLines(windowsProcessLines()).find((p) => p.pid === pid);
    return hit ? procName(hit.name) : '';
  }
  const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? procName(r.stdout) : '';
}

export function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A tool on the PATH, found without starting a shell. `fresh` looks again past the cache: what was
// missing before an install may be there after it.
const whichCache = new Map<string, string>();
export function which(cmd: string, fresh = false): string {
  const hit = fresh ? undefined : whichCache.get(cmd);
  if (hit !== undefined) return hit;
  let found = '';
  const exts = isWindows ? windowsExtensions(cmd) : [''];
  outer: for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      try {
        if (!statSync(p).isFile()) continue;
        if (!isWindows) accessSync(p, constants.X_OK);
        found = p;
        break outer;
      } catch {
        // not here
      }
    }
  }
  whichCache.set(cmd, found);
  return found;
}

// Is something accepting connections on this port of this machine? A connection is a millisecond,
// where asking lsof cost a process.
export async function isListening(port: number, timeoutMs = 400): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const s = connect({ port, host });
      const done = (ok: boolean): void => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  return (await tryHost('127.0.0.1')) || (await tryHost('::1'));
}

// The processes listening on a port: what `down` stops, and what tells an isolated Metro from
// another owner's.
export function listenerPids(port: number): number[] {
  if (isWindows) {
    const r = spawnSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true });
    return parseNetstatListeners(r.stdout ?? '', port);
  }
  if (which('lsof')) {
    const r = spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return [...new Set((r.stdout ?? '').split('\n').filter(Boolean).map(Number))];
  }
  if (which('ss')) {
    const r = spawnSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8' });
    return [...new Set([...(r.stdout ?? '').matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
  }
  return [];
}

// A page or an image handed to a human: the system's own viewer.
export function openForHuman(target: string): void {
  if (isMac) {
    spawnSync('open', [target], { stdio: 'ignore' });
  } else if (isWindows) {
    // `start` takes its first quoted argument as a window title: the empty one is that title.
    spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"start "" ${cmdQuote(target)}"`], {
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else if (isWsl && which('wslview')) {
    spawnSync('wslview', [target], { stdio: 'ignore' });
  } else if (which('xdg-open')) {
    spawnSync('xdg-open', [target], { stdio: 'ignore' });
  }
}

// How a command line written in a config (`pnpm --filter web dev`, `make -s dev-up`) is run. On
// Windows it goes to cmd.exe as it was written, the way Node's own `shell: true` passes it: quoted
// whole after /s /c and handed over verbatim (the caller spawns with windowsVerbatimArguments), since
// Node's default quoting escapes inner quotes with backslashes, which cmd.exe does not read.
export function shellArgv(command: string): [string, string[]] {
  if (isWindows) return [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]];
  return ['/bin/sh', ['-c', command]];
}

// The extensions a bare name may take on Windows, in PATHEXT order. A name without one is never
// spawnable as it is: npm's folder holds an extensionless `npm` for Git Bash beside `npm.cmd`.
function windowsExtensions(cmd: string): string[] {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  return exts.includes(extname(cmd).toLowerCase()) ? [''] : exts;
}

// One argument for a cmd.exe command line: bare when it holds nothing cmd reads, quoted otherwise.
export function cmdQuote(arg: string): string {
  if (arg && /^[A-Za-z0-9_\-.,:/\\=@+]+$/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

// A tool found on the PATH, as argv to spawn. npm, npx and every npm-installed CLI are `.cmd` shims
// on Windows, which Node refuses to spawn without a shell since the batch-file fix of April 2024
// (CVE-2024-27980): those go through cmd.exe, verbatim, with each argument quoted for it.
export function toolArgv(cmd: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (!isWindows) return { file: cmd, args, verbatim: false };
  const path = which(cmd) || cmd;
  if (!/\.(cmd|bat)$/i.test(path)) return { file: path, args, verbatim: false };
  const line = [path, ...args].map(cmdQuote).join(' ');
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}
