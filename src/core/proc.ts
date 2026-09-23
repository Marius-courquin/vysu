// Starting the tools vysu drives: waited for with their output, or detached so they outlive the
// command (a dev server, Metro, an emulator, a log tail).
import { spawn, type SpawnOptions } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { isWindows, shellArgv, toolArgv } from './host.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
  // Output straight to this process's own streams, as a passthrough does.
  inherit?: boolean;
  // Windows: the arguments are already a cmd.exe command line (see shellArgv, toolArgv).
  verbatim?: boolean;
}

// Waits for the process and hands back what it said. Never throws for a non-zero exit: the caller
// reads the code, which is what every « || die … » of the bash engine did.
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', opts.inherit ? 'inherit' : 'pipe', opts.inherit ? 'inherit' : 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: opts.verbatim,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: String(e.message) });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? (signal ? 128 + 9 : 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    // A child that exits without reading all of its input must not take this process down with EPIPE.
    child.stdin?.on('error', () => undefined);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

// Binary output (a PNG on stdout).
export function runBuffer(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => resolve({ code: 127, stdout: Buffer.alloc(0), stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

// A process that outlives vysu, its output in a log file. Returns its pid.
export function spawnDetached(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; log: string; verbatim?: boolean }): number {
  mkdirSync(dirname(opts.log), { recursive: true });
  const fd = openSync(opts.log, 'w');
  const o: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    windowsVerbatimArguments: opts.verbatim,
  };
  const child = spawn(cmd, args, o);
  child.on('error', () => undefined);
  child.unref();
  closeSync(fd);
  return child.pid ?? 0;
}

// A command line from a config, detached, through the platform's shell.
export function spawnShellDetached(command: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; log: string }): number {
  const [sh, args] = shellArgv(command);
  return spawnDetached(sh, args, { ...opts, verbatim: isWindows });
}

// A command line from a config, waited for (a health check, a stop command).
export function runShell(command: string, opts: RunOptions = {}): Promise<RunResult> {
  const [sh, args] = shellArgv(command);
  return run(sh, args, { ...opts, verbatim: isWindows });
}

// A tool on the PATH by its name (npm, git, agent-browser), wherever it is a `.cmd` shim.
export function runTool(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const t = toolArgv(cmd, args);
  return run(t.file, t.args, { ...opts, verbatim: t.verbatim });
}

export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!(pid > 0)) return;
  try {
    if (isWindows) {
      spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // already gone
  }
}
