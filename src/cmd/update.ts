// `vysu update`: the engine fast-forwarded (moved off a tag onto the default branch when it was
// pinned), the CHANGELOG since the version it was on, its own dependencies when their lock changed,
// the two node tools brought up to what tools.env asks, and a reminder when this project's skills are
// older than the engine. Every module it needs is loaded before the pull: the code on disk changes
// under it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { die } from '../core/errors.ts';
import { which } from '../core/host.ts';
import { run as spawnRun } from '../core/proc.ts';
import { head, info, miss, ok } from '../core/ui.ts';
import { engineDepsVersion, engineVersion, git, npmCiEngine, toolsCheck } from '../setup/engine.ts';
import { skillsLine } from '../setup/skills.ts';

// git with its output straight on this terminal: a pull's own lines and errors say the most.
const gitLoud = async (args: string[]): Promise<number> => (await spawnRun(which('git') || 'git', ['-C', ENGINE, ...args], { inherit: true })).code;

// The branch the remote points at, for an engine checked out at a tag.
async function engineDefaultBranch(): Promise<string> {
  const head = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.out) return head.out.replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    if ((await git(['rev-parse', '-q', '--verify', `refs/remotes/origin/${b}`])).code === 0) return b;
  }
  return 'main';
}

// The CHANGELOG entries between the two, by their headings: what changed is what is printed.
export function changelogSince(text: string, from: string): string {
  const out: string[] = [];
  let show = false;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('## ')) {
      if (line.trim().split(/\s+/)[1] === from) break;
      show = true;
    }
    if (show) out.push(line);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

export async function run(): Promise<void> {
  const before = engineVersion();
  const beforeSha = (await git(['rev-parse', 'HEAD'])).out;
  head('engine');
  // An engine pinned at a tag has no branch to fast-forward: `update` is how you leave the pin, so it
  // fetches and moves onto the remote's default branch rather than reporting a git error.
  if ((await git(['symbolic-ref', '-q', 'HEAD'])).code !== 0) {
    const branch = await engineDefaultBranch();
    const at = await git(['describe', '--tags', '--always']);
    info(`engine: detached at ${at.code === 0 && at.out ? at.out : '?'} — moving onto ${branch}`);
    if ((await gitLoud(['fetch', '-q', 'origin'])) !== 0) die(`update: git fetch failed in ${ENGINE}`, `cd ${ENGINE} && git fetch origin`);
    if ((await git(['checkout', '-q', branch])).code !== 0 && (await gitLoud(['checkout', '-q', '-b', branch, `origin/${branch}`])) !== 0) {
      die(`update: cannot move onto ${branch} in ${ENGINE}`, `cd ${ENGINE} && git checkout ${branch}`);
    }
  }
  if ((await gitLoud(['pull', '--ff-only'])) !== 0) die(`update: git pull --ff-only failed in ${ENGINE}`, `cd ${ENGINE} && git status`);
  const after = engineVersion();
  if (before === after) ok(`vysu: already at ${after}`);
  else {
    ok(`vysu: ${before} → ${after}`);
    try {
      process.stdout.write(changelogSince(readFileSync(join(ENGINE, 'CHANGELOG.md'), 'utf8'), before));
    } catch {
      // no CHANGELOG in this engine
    }
  }
  // The engine runs on its own node_modules (sharp): installed again when the lock moved, or when
  // they were never there.
  const afterSha = (await git(['rev-parse', 'HEAD'])).out;
  const lockMoved = !!beforeSha && beforeSha !== afterSha && (await git(['diff', '--quiet', beforeSha, afterSha, '--', 'package-lock.json'])).code === 1;
  if (lockMoved || !engineDepsVersion()) {
    info(`engine: ${lockMoved ? 'package-lock.json changed' : 'dependencies missing'} — npm ci --omit=dev…`);
    const failed = await npmCiEngine();
    if (!failed) ok(`engine: dependencies installed (sharp ${engineDepsVersion()})`);
    else miss(`engine: ${failed}`, `cd ${ENGINE} && npm ci --omit=dev`);
  }
  head('tools');
  await toolsCheck('install');
  head('skills');
  skillsLine(after);
}
