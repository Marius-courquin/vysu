// The skills, and which version of the engine wrote them. `init` stamps every SKILL.md it copies with
// `<!-- vysu-skill <version> -->` right after the frontmatter, so `doctor` can say that a project is
// running last month's instructions against this month's engine — the failure mode nobody notices,
// because nothing breaks: the agent simply does the old thing.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { info, ok, warn } from '../core/ui.ts';
import { engineVersion } from './engine.ts';

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Where this project's commands run from: the project found, else the folder vysu was run in.
export function projectRoot(): string {
  const dir = config().projectDir;
  if (dir) return dir;
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

export function skillsTarget(): string {
  return join(projectRoot(), '.claude', 'skills');
}

// The engine's skills, in the order a shell glob lists them.
export function engineSkills(): string[] {
  const dir = join(ENGINE, 'skill');
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && isDir(join(dir, n)))
    .sort();
}

// The marker goes right after the closing `---` of the frontmatter, with a blank line before the
// body; a file with no frontmatter gets it on top.
export function stampText(text: string, version: string): string {
  const mark = `<!-- vysu-skill ${version} -->`;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      const out = [...lines.slice(0, close + 1), '', mark, ...lines.slice(close + 1)];
      return `${out.join('\n')}\n`;
    }
  }
  return `${mark}\n\n${text}`;
}

function skillStamp(file: string, version: string): void {
  const tmp = `${file}.vysu-tmp`;
  writeFileSync(tmp, stampText(readFileSync(file, 'utf8'), version));
  renameSync(tmp, file);
}

// Every skill of this engine, stamped; says nothing when it has none.
export function skillsInstall(target: string): void {
  const v = engineVersion('0.0.0');
  const skills = engineSkills();
  if (!skills.length) return;
  mkdirSync(target, { recursive: true });
  for (const name of skills) {
    const dst = join(target, name);
    rmSync(dst, { recursive: true, force: true });
    cpSync(join(ENGINE, 'skill', name), dst, { recursive: true });
    const skill = join(dst, 'SKILL.md');
    if (existsSync(skill)) skillStamp(skill, v);
    console.log(`installed skill: ${dst} (${v})`);
  }
}

// The oldest marker among the installed skills: one stale copy is what the reminder is about.
export function skillsInstalledVersion(target: string): string {
  const found: string[] = [];
  for (const name of engineSkills()) {
    const f = join(target, name, 'SKILL.md');
    if (!existsSync(f)) continue;
    const m = /^<!-- vysu-skill ([^ \n]*) -->$/m.exec(readFileSync(f, 'utf8'));
    found.push(m?.[1] || '0.0.0');
  }
  return found.sort()[0] ?? '';
}

// The doctor / update line about this project's installed skills.
export function skillsLine(engine: string): void {
  const target = skillsTarget();
  const have = skillsInstalledVersion(target);
  if (!have) {
    if (isDir(target)) warn(`skills: none of this engine's skills in ${target}`, 'vysu init --refresh-skills');
    else info(`skills: none installed here (no ${target})`);
  } else if (have !== engine) {
    warn(`skills: installed ${have} · engine ${engine}`, 'vysu init --refresh-skills');
  } else {
    ok(`skills: ${have} (${target})`);
  }
}
