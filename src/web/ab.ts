// Everything that goes through agent-browser: which binary, which session, which lock, and the
// batch a whole capture run is queued into. One session per persona (`<project>-<persona>`), its
// cookies and storage restored on every call, the persona's `web-<persona>` lock taken on the first.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { isExecutable, isWindows, nativeTarget, toolArgv, which } from '../core/host.ts';
import { lockTake } from '../core/hold.ts';
import type { RunResult } from '../core/proc.ts';
import { slug } from '../core/text.ts';

// agent-browser's npm package ships one native binary per platform next to a node wrapper that
// only picks one and spawns it: ~70 ms of node start-up before every call, a dozen calls per
// capture. The binary is found from the command on the PATH, whatever that command is (the
// wrapper, a symlink a global install patched to the binary, a Windows .cmd shim); the command
// itself is the fallback.
let binary = '';
export function abBinary(): string {
  if (binary) return binary;
  const onPath = which('agent-browser');
  if (!onPath) return (binary = 'agent-browser');
  let real = onPath;
  try {
    real = realpathSync(onPath);
  } catch {
    // a dangling link: the PATH command it is
  }
  binary = abCandidates(onPath, real, `agent-browser-${nativeTarget()}`).find((c) => isExecutable(c)) ?? onPath;
  return binary;
}

// Where the native binary may be, in order. npm on Windows puts a `.cmd` shim in <prefix> and the
// package's binaries in <prefix>\node_modules\agent-browser\bin. No arm64 Windows build is published:
// the x64 one runs there under emulation, which is what the package's own shim runs.
export function abCandidates(onPath: string, real: string, want: string, windows = isWindows): string[] {
  const p = windows ? win32 : posix;
  const dirs = [p.dirname(real)];
  if (windows) dirs.push(p.join(p.dirname(onPath), 'node_modules', 'agent-browser', 'bin'));
  const names = windows && want.includes('arm64') ? [want, want.replace('arm64', 'x64')] : [want];
  const out = p.basename(real).startsWith('agent-browser-') && !real.endsWith('.js') ? [real] : [];
  for (const name of names) for (const d of dirs) out.push(p.join(d, name));
  return out;
}

// `vysu auth test` drives a session of its own — its own profile, no cookies, dropped at the end —
// while the connector it exercises still reads the credentials of the real persona it was given.
// Set for the duration of a test, empty the rest of the time; a bash connector's primitives run in
// a child vysu, which reads it from the environment.
let authTestSession = process.env.VYSU_AUTH_TEST_SESSION ?? '';
export function setAuthTestSession(s: string): void {
  authTestSession = s;
}
export const authTestSessionName = (): string => authTestSession;

export function sessionOf(persona: string): string {
  return authTestSession || `${config().get('PROJECT')}-${persona}`;
}
// What that session's lock is called: a test must not hold the real persona's session, which it
// never touches, for as long as it runs.
export function webLockOf(persona: string): string {
  return authTestSession ? 'web-authtest' : `web-${slug(persona)}`;
}
// Where agent-browser keeps a session's restore file (`--restore` with no name keys it on the
// session): what carries a login from one run to the next.
export function restoreFile(session: string): string {
  return join(homedir(), '.agent-browser', 'sessions', `${session}-${session}.json`);
}

// Which browser every session runs in. Empty by default, and that is the point: agent-browser
// downloads Chrome for Testing and drives it headless, so a capture looks the same on every
// machine, no personal profile is touched and no extension rewrites the page. VYSU_BROWSER_PATH
// names an installed Chromium-based browser instead, for whoever wants to see their own.
export function browserOpts(): string[] {
  const exe = config().get('BROWSER_PATH');
  const args = config().get('BROWSER_ARGS');
  const out: string[] = [];
  if (exe) {
    if (!isExecutable(exe)) die(`VYSU_BROWSER_PATH is not an executable: ${exe}`, 'vysu setup --browser default');
    out.push('--executable-path', exe);
  }
  if (args) out.push('--args', args);
  return out;
}
// What to call the browser in a report.
export function browserName(): string {
  const exe = config().get('BROWSER_PATH');
  if (!exe) return 'Chrome for Testing (agent-browser default, headless)';
  return `${basename(exe)} · ${exe}`;
}

// agent-browser announces « restore: loaded; save: saved » on stderr once per call: a dozen
// identical lines for one flow, and nothing an agent can act on. Dropped here rather than at every
// call site, so anything else it has to say — and its exit code — still comes through.
const NOISE = /^\[agent-browser\] (restore|save):/;
export function quiet(stderr: string): string {
  if (!stderr) return '';
  const lines = (stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr).split('\n');
  const kept = lines.filter((l) => !NOISE.test(l));
  return kept.length ? `${kept.join('\n')}\n` : '';
}

export interface AbOptions {
  // What becomes of agent-browser's stderr, once filtered: printed after the call (the default),
  // dropped (`2>/dev/null`), or handed back in the result.
  stderr?: 'pass' | 'drop' | 'capture';
  // Straight to this process's stdout as it comes, for the passthrough.
  inherit?: boolean;
  input?: string;
  // No session lock: a call that addresses no session (`session list`, a throwaway's `close`).
  bare?: boolean;
}

export async function abRaw(args: string[], o: AbOptions = {}): Promise<RunResult> {
  // With no native binary found on Windows, the command is npm's `.cmd` shim: through cmd.exe, which
  // Node requires of a batch file since the April 2024 fix (CVE-2024-27980).
  const t = toolArgv(abBinary(), args);
  const child = spawn(t.file, t.args, {
    env: config().childEnv(),
    stdio: [o.input === undefined ? (o.inherit ? 'inherit' : 'ignore') : 'pipe', o.inherit ? 'inherit' : 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: t.verbatim,
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const mode = o.stderr ?? 'pass';
  // A passthrough may run for as long as the command it passes (a recording, a stream): its stderr
  // goes out line by line, filtered, rather than at the end.
  let partial = '';
  const stream = o.inherit && mode === 'pass';
  child.stdout?.on('data', (b: Buffer) => out.push(b));
  child.stderr?.on('data', (b: Buffer) => {
    if (!stream) return void err.push(b);
    const text = partial + b.toString('utf8');
    const cut = text.lastIndexOf('\n');
    partial = text.slice(cut + 1);
    if (cut >= 0) process.stderr.write(quiet(text.slice(0, cut + 1)));
  });
  if (o.input !== undefined) child.stdin?.end(o.input);
  const code = await new Promise<number>((resolve) => {
    child.on('error', (e) => {
      err.push(Buffer.from(`vysu: agent-browser: ${e.message}\n`));
      resolve(127);
    });
    child.on('close', (c, signal) => resolve(c ?? (signal ? 137 : 1)));
  });
  if (stream && partial) err.unshift(Buffer.from(partial));
  const stderr = quiet(Buffer.concat(err).toString('utf8'));
  if (mode === 'pass' && stderr) process.stderr.write(stderr);
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: mode === 'capture' ? stderr : '' };
}

export async function ab(persona: string, args: string[], o: AbOptions = {}): Promise<RunResult> {
  await lockTake(webLockOf(persona));
  return abRaw(['--session', sessionOf(persona), '--restore', ...browserOpts(), ...args], o);
}

// `… | tail -1`: the last line of an answer, which is where agent-browser puts the value.
export function lastLine(s: string): string {
  const t = s.endsWith('\n') ? s.slice(0, -1) : s;
  return t.slice(t.lastIndexOf('\n') + 1).replace(/\r$/, '');
}
// The value an `eval` printed: agent-browser prints it as JSON, a string in quotes. Parsed rather
// than stripped of every quote, so a value holding one comes back whole.
export function evalValue(stdout: string): string {
  const line = lastLine(stdout);
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === 'string') return v;
  } catch {
    // not JSON: as printed
  }
  return line.replaceAll('"', '');
}

// Whether the session is running now: `agent-browser session list` names it.
export async function sessionRunning(persona: string): Promise<boolean> {
  const r = await abRaw(['session', 'list'], { stderr: 'drop' });
  const want = sessionOf(persona);
  return r.stdout.split('\n').some((l) => l.trim() === want);
}

// --- the batch -------------------------------------------------------------------------------------

// One process for a whole sequence instead of one per step: a capture run is a dozen commands.
// Handed over as JSON on stdin, so a CSS selector or a block of JS never meets a shell's nor the
// command parser's quoting rules.
const queue: string[][] = [];
export function bcmd(...args: string[]): void {
  queue.push(args);
}
// persona → the batch results as JSON, the queue emptied.
export async function brun(persona: string): Promise<string> {
  await lockTake(webLockOf(persona));
  const json = JSON.stringify(queue.splice(0));
  return (await ab(persona, ['batch', '--json'], { input: json })).stdout;
}

export interface BatchResult {
  command?: string[];
  success?: boolean;
  error?: unknown;
  result?: { result?: unknown } | null;
}

// Reads those results: a failed step stops vysu here with what agent-browser said, and every
// « /*vysubox*/ » eval — the boxes an --ignore selector resolved to — comes back as one line. A wait
// that timed out is not a failure: the dashboard of a live app never goes network-idle, and the
// capture after it is still the picture that was asked for (hence no --bail either).
// « /*vysuexpand*/ » and « /*vysuwarm*/ » go to stderr instead: one line per viewport saying what
// the expansion and the warm-up scroll did, and the answer stays one line per --ignore eval, which
// is what the caller indexes by viewport.
export function bboxes(json: string, err: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): string[] {
  let rs: BatchResult[];
  try {
    rs = JSON.parse(json.trim() || '[]');
  } catch {
    die('agent-browser batch returned nothing');
  }
  const boxes: string[] = [];
  for (const r of rs) {
    const c = r.command ?? [];
    if (!r.success && (c[0] ?? '') !== 'wait') die(`« ${c.join(' ')} » failed: ${r.error ?? 'None'}`);
    const res = (r.result ?? {}).result;
    if (c.length > 1 && c[0] === 'eval' && c[1]!.startsWith('/*vysubox*/')) {
      const list = Array.isArray(res) ? (res as number[][]) : [];
      boxes.push(list.map((b) => b.map((n) => Math.trunc(n)).join(',')).join(' '));
    }
    if (c.length > 1 && c[0] === 'eval' && c[1]!.startsWith('/*vysuexpand*/')) {
      const [n, h] = Array.isArray(res) && res.length ? (res as number[]) : [0, 0];
      err(`expand: ${Math.trunc(n ?? 0)} pane(s) unfolded, document ${Math.trunc(h ?? 0)} px`);
    }
    if (c.length > 1 && c[0] === 'eval' && c[1]!.startsWith('/*vysuwarm*/')) {
      const n = typeof res === 'number' ? res : 0;
      err(`warm: ${n ? `${Math.trunc(n)} scroll step(s)` : 'skipped, the page fits the viewport'}`);
    }
  }
  return boxes;
}

// The value the last command of a batch answered (an eval read after a run of settings).
export function lastResult(json: string): string {
  try {
    const rs = JSON.parse(json) as BatchResult[];
    const v = (rs.at(-1)?.result ?? {}).result;
    return v === undefined || v === null || v === '' || v === false || v === 0 ? '' : String(v);
  } catch {
    return '';
  }
}
