// The visual check as a delegated task: which model a checker sub-agent runs on, for whichever agent
// tool is asking, and the agent definition `vysu init` installs for the tools that read one. The
// principle (a short-context checker, a brief, a report contract) lives in the skill, where every
// agent reads it; only the model is tool-specific, so it is a project setting:
//   VYSU_CHECKER_MODELS='claude=sonnet,codex=gpt-5.6-luna'
// keyed by the agent family vysu already knows its caller by (`claude:41234` → claude).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { owner } from '../core/hold.ts';
import { engineVersion } from './engine.ts';

// The caller's agent family: the owner's name, lower-cased, without its pid.
export function checkerFamily(): string {
  const who = owner();
  const at = who.indexOf(':');
  return (at < 0 ? who : who.slice(0, at)).toLowerCase();
}

// The model the project names for that family, or '' (inherit the caller's).
export function checkerModel(family: string): string {
  for (const raw of config().get('CHECKER_MODELS').split(',')) {
    const pair = raw.replaceAll(' ', '');
    const eq = pair.indexOf('=');
    if ((eq < 0 ? pair : pair.slice(0, eq)) === family) return eq < 0 ? pair : pair.slice(eq + 1);
  }
  return '';
}

// The template with its `model:` line set to the model, or dropped when there is none, and stamped
// like the skills right after the frontmatter, so a stale copy can be told from a fresh one.
export function checkerAgentText(template: string, model: string, version: string): string {
  const out: string[] = [];
  for (const line of template.split(/(?<=\n)/)) {
    if (line.startsWith('model:')) {
      if (!model) continue;
      out.push(`model: ${model}\n`);
    } else out.push(line);
  }
  const text = out.join('');
  const sep = '\n---\n';
  const at = text.indexOf(sep);
  const stamp = `<!-- vysu-agent ${version} -->\n`;
  if (at < 0) return text + stamp;
  return text.slice(0, at + sep.length) + stamp + text.slice(at + sep.length);
}

// The Claude Code agent definition, from the engine's template: the model is the project's claude
// entry, and a project that names none gets no `model:` line (the sub-agent inherits the caller's).
// Codex has no such file to read (its spawn_agent takes the model as an argument instead): the
// skill tells it to ask `vysu checker`.
export function checkerAgentInstall(target: string): void {
  const src = join(ENGINE, 'templates', 'agents', 'visual-checker.md');
  if (!existsSync(src)) return;
  mkdirSync(target, { recursive: true });
  const model = checkerModel('claude');
  writeFileSync(join(target, 'visual-checker.md'), checkerAgentText(readFileSync(src, 'utf8'), model, engineVersion('0.0.0')));
  console.log(`installed agent: ${join(target, 'visual-checker.md')} (model: ${model || 'inherited'})`);
}
