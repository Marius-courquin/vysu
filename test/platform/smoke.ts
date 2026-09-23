// The engine as a user starts it, on whatever machine runs this: the launcher of the platform
// (bin/vysu, or bin\vysu.cmd on Windows), then the commands that need no device and no browser —
// help, version, persona list, report and sheet on the fixture shots, checker and doctor (the owner
// walk over the process table), setup --dry-run, init, and up / down of a node server. What CI runs
// on macOS, Linux and Windows; it needs no network and leaves nothing behind.
//
//   node test/platform/smoke.ts
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENGINE = resolve(import.meta.dirname, '..', '..');
const isWindows = process.platform === 'win32';
const tmp = mkdtempSync(join(tmpdir(), 'vysu-smoke-'));
const shots = join(tmp, 'shots');
cpSync(join(ENGINE, 'test', 'fixtures', 'shots'), shots, { recursive: true });

const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  VYSU_STATE: join(tmp, 'state'),
  VYSU_SHOTS: shots,
  VYSU_PERSONAS: join(ENGINE, 'test', 'fixtures', 'personas.env'),
  VYSU_NO_COLOR: '1',
};

// bin\vysu.cmd is a batch file: Node spawns one only through cmd.exe, with the line handed over as
// written.
function vysu(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { code: number; out: string; err: string } {
  const env = { ...baseEnv, ...opts.env };
  const r = isWindows
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${join(ENGINE, 'bin', 'vysu.cmd')}" ${args.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a}"`)).join(' ')}"`], {
        cwd: opts.cwd ?? tmp,
        env,
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        timeout: 60_000,
      })
    : spawnSync(join(ENGINE, 'bin', 'vysu'), args, { cwd: opts.cwd ?? tmp, env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

let failed = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) console.log(`ok       ${name}`);
  else {
    failed++;
    console.log(`FAILED   ${name}\n${detail.replace(/^/gm, '    ')}`);
  }
}
const show = (r: { code: number; out: string; err: string }): string => `exit ${r.code}\n--- stdout\n${r.out}--- stderr\n${r.err}`;

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });

try {
  let r = vysu(['help']);
  check('help', r.code === 0 && r.out.includes('vysu <persona>'), show(r));

  r = vysu(['version']);
  check('version', r.code === 0 && /^vysu \d+\.\d+\.\d+ \(/.test(r.out), show(r));

  r = vysu(['persona', 'list', '--json']);
  let names: string[] = [];
  try {
    names = (JSON.parse(r.out) as Array<{ name: string }>).map((p) => p.name);
  } catch {
    // reported below
  }
  check('persona list --json', r.code === 0 && names.join(',') === 'alice,tb_non_verifie', show(r));

  r = vysu(['report', 'home']);
  check('report (web)', r.code === 0 && r.out.startsWith('web · - · https://example.com/') && r.out.includes('check: clean'), show(r));
  r = vysu(['report', 'phone']);
  check('report (mobile)', r.code === 0 && r.out.includes('ios-detail: vs previous · unchanged'), show(r));

  r = vysu(['sheet', 'home']);
  check('sheet', r.code === 0 && existsSync(join(shots, 'home', 'sheet.png')) && existsSync(join(shots, 'home', 'index.html')), show(r));
  r = vysu(['sheet', 'phone', '--strip']);
  check('sheet --strip', r.code === 0 && existsSync(join(shots, 'phone', 'sheet-strip.png')), show(r));

  r = vysu(['checker', '--for', 'codex']);
  check('checker', r.code === 0 && r.out.includes('model for codex'), show(r));
  r = vysu(['checker']);
  check('checker (owner from the process table)', r.code === 0 && /model for [a-z0-9._-]+:/.test(r.out), show(r));

  r = vysu(['doctor']);
  check('doctor', r.code === 0 && r.out.includes('project: default') && r.out.includes('cache: (empty)'), show(r));

  r = vysu(['setup', '--dry-run']);
  check('setup --dry-run', (r.code === 0 || r.code === 1) && r.out.includes('## summary') && r.out.includes('machine.env'), show(r));

  const project = join(tmp, 'project');
  mkdirSync(join(project, '.claude'), { recursive: true });
  r = vysu(['init', '--yes'], { cwd: project });
  check(
    'init --yes',
    r.code === 0 && existsSync(join(project, '.vysu', 'config')) && existsSync(join(project, '.claude', 'skills', 'visual-check', 'SKILL.md')),
    show(r),
  );

  // A service: a node server in the project, up through the platform's shell, down by its port.
  const port = await freePort();
  writeFileSync(join(project, 'server.mjs'), "import http from 'node:http';\nhttp.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));\n");
  const config = readFileSync(join(project, '.vysu', 'config'), 'utf8');
  writeFileSync(
    join(project, '.vysu', 'config'),
    `${config}\nVYSU_SERVICES='hello'\nVYSU_SERVICE_hello_CMD='node server.mjs'\nVYSU_SERVICE_hello_PORT=${port}\nVYSU_SERVICE_hello_HEALTH='http://localhost:${port}/'\nVYSU_SERVICE_hello_ENV='PORT=${port}'\n`,
  );
  // Read through pipes, as an agent reads it: a service holding vysu's stdout would keep this call
  // waiting until the timeout.
  const t0 = performance.now();
  r = vysu(['up', 'hello'], { cwd: project });
  const upMs = performance.now() - t0;
  check('up (a node server)', r.code === 0 && r.out.startsWith(`hello: http://localhost:${port} — PORT=${port}`), show(r));
  check('up returns while the service runs', upMs < 30_000, `took ${upMs.toFixed(0)} ms`);
  r = vysu(['up', 'hello'], { cwd: project });
  check('up again (already listening)', r.code === 0 && r.out.includes(`already listening on ${port}`), show(r));
  r = vysu(['down', 'hello'], { cwd: project });
  check('down (by its port)', r.code === 0 && r.out.trim() === 'hello: stopped', show(r));
  r = vysu(['up', 'hello'], { cwd: project });
  check('up after down', r.code === 0 && r.out.startsWith('hello: http://localhost:'), show(r));
  vysu(['down', 'hello'], { cwd: project });
} finally {
  try {
    // Windows keeps a file busy for a moment after the process that held it is gone.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.log(`(left ${tmp} behind)`);
  }
}

console.log(failed ? `smoke: ${failed} failed` : 'smoke: all passed');
process.exitCode = failed ? 1 : 0;
