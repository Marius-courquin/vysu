// `vysu video <take> [--format landscape|portrait|all] [--check] [--draft] [--out <dir>]`: the
// Remotion toolkit, behind one command. vysu owns the take, the toolkit owns the pixels; the toolkit
// installs itself on the first render that needs it.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { which } from '../core/host.ts';
import { runTool } from '../core/proc.ts';

const USAGE = 'usage: vysu video <take> [--format landscape|portrait|all] [--check] [--draft] [--out <dir>]';

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export async function run(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (!name) die(USAGE);
  const c = config();
  const dir = join(c.shots, name);
  if (!isDir(dir)) die(`no shots folder ${dir}`);
  if (!existsSync(join(dir, 'cut.json'))) die(`vysu video: no ${dir}/cut.json — vysu cut ${name} --draft first`);
  const remotion = c.remotion;
  if (!existsSync(join(remotion, 'scripts', 'render.ts'))) die(`vysu video: ${remotion}/scripts/render.ts missing (the Remotion toolkit)`);
  // Installed on the first render that needs it, once, and it says so: a clone of the engine is a
  // few hundred kB, and nobody pays for Remotion until they ask for a video.
  if (!isDir(join(remotion, 'node_modules'))) {
    process.stderr.write(`vysu video: installing the Remotion toolkit in ${remotion} (once, a few minutes)…\n`);
    const r = await runTool('npm', ['ci'], { cwd: remotion, inherit: false });
    if (r.code !== 0) {
      process.stderr.write(r.stderr);
      die(`vysu video: npm ci failed in ${remotion}`);
    }
  }
  // The render script is TypeScript run as it is, on Node whatever runs vysu: Remotion needs Node.
  // VYSU_DIR and VYSU_PROJECT_DIR are what let it resolve a theme the project owns before one the
  // engine ships.
  const node = process.versions.bun ? which('node') || 'node' : process.execPath;
  const argv = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join('scripts', 'render.ts'), '--take', dir, ...rest];
  return new Promise((resolve) => {
    const child = spawn(node, argv, { cwd: remotion, env: c.childEnv(), stdio: 'inherit' });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (e) => {
      process.stderr.write(`vysu video: ${e.message}\n`);
      resolve(127);
    });
  });
}
