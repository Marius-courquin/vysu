// The first file Node runs, plain JavaScript on purpose: it has to speak on a Node too old to read the
// engine's TypeScript, and on a checkout whose dependencies are not installed yet — the state a
// machine is in right after an update from a bash engine, whose updater never ran npm.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, next) {
  process.stderr.write(`vysu: ${message}\n`);
  if (next) process.stderr.write(`next: ${next}\n`);
  process.exit(1);
}

// Types are stripped without a flag from Node 22.18 on the 22 line, 23.6 on the 23 line.
const [major, minor] = process.versions.node.split('.').map(Number);
const bun = typeof globalThis.Bun !== 'undefined';
if (!bun && !(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18))) {
  fail(`Node ${process.versions.node} is too old: the engine runs on Node 22.18 or later`, 'install Node 24 (https://nodejs.org), then open a new terminal');
}

// The one warning every command would print: type stripping is still called experimental on some
// Node lines. Every other warning is printed as Node would.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`);
});

// Dependencies installed once, by whichever command needs them first; the others wait for it.
if (!existsSync(join(engine, 'node_modules', 'sharp', 'package.json'))) {
  const lock = join(engine, '.install-lock');
  let mine = false;
  for (let i = 0; i < 600 && !mine; i++) {
    try {
      mkdirSync(lock);
      mine = true;
    } catch {
      // Another command is installing; a lock older than ten minutes is one that died.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 600_000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (existsSync(join(engine, 'node_modules', 'sharp', 'package.json'))) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  if (mine) {
    let installed = true;
    if (!existsSync(join(engine, 'node_modules', 'sharp', 'package.json'))) {
      process.stderr.write("vysu: installing the engine's dependencies, once (npm ci --omit=dev)\n");
      const win = process.platform === 'win32';
      const r = spawnSync(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: engine,
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: win,
      });
      installed = r.status === 0;
    }
    rmSync(lock, { recursive: true, force: true });
    if (!installed) fail("the engine's dependencies did not install", `cd "${engine}" && npm ci --omit=dev`);
  }
}

await import('../src/cli.ts');
