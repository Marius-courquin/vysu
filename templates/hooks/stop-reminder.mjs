#!/usr/bin/env node
// vysu Stop hook — reminds you to check the UI on the real app when UI files changed. The portable
// form of stop-reminder.sh: the same output, on macOS, Linux and Windows, with nothing but node and git.
//
// It only prints: it runs no capture, changes nothing, and is agent-agnostic (any tool that can run a
// script at the end of a turn can use it; Claude Code reads its stdout).
//
// Install (Claude Code): copy it into the project and add it as a `Stop` hook command in
// .claude/settings.json — `node .claude/hooks/stop-reminder.mjs`. Run it by hand to see what it would
// say. It is standalone on purpose: a copy in a project imports nothing from the engine.
//
// Which files count as UI comes from VYSU_UI_GLOBS, comma-separated, matched against the paths
// `git status --porcelain` reports (a leading `**/` matches at any depth):
//   default: **/*.tsx,**/*.vue,**/*.svelte,**/*.css
// Set it in the environment, or in the project's .vysu/config (VYSU_UI_GLOBS='src/**/*.tsx,…').
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The hook payload arrives on stdin and is not needed here: read to its end, so the writer never
// meets a closed pipe.
if (!process.stdin.isTTY) {
  try {
    readFileSync(0);
  } catch {
    // no stdin at all
  }
}

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

const root = process.env.CLAUDE_PROJECT_DIR || git(['rev-parse', '--show-toplevel']).stdout?.trim() || process.cwd();

let globs = process.env.VYSU_UI_GLOBS || '';
if (!globs) {
  try {
    for (const line of readFileSync(join(root, '.vysu', 'config'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*VYSU_UI_GLOBS=['"]?([^'"]*)['"]?\s*$/.exec(line);
      if (m) globs = m[1];
    }
  } catch {
    // no config: the default
  }
}
globs ||= '**/*.tsx,**/*.vue,**/*.svelte,**/*.css';

// A shell `case` pattern: `*` and `?` match any character, `/` included, and `[…]` a set.
function matches(path, glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let set = glob.slice(i + 1, end);
        if (set.startsWith('!')) set = `^${set.slice(1)}`;
        re += `[${set.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(path);
}

// -uall: an untracked folder is otherwise reported as the folder, and no glob would ever match it.
const status = git(['status', '--porcelain', '-uall'], root);
if (status.status !== 0) process.exit(0);
const changed = status.stdout
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"/, '').replace(/"$/, ''));
if (!changed.length) process.exit(0);

const patterns = globs.split(',').filter(Boolean);
// `**/x` means « x at any depth », which a plain `*` already does against a whole path.
const hits = changed.filter((p) => patterns.some((g) => matches(p, g.replace(/^\*\*\//, '')) || matches(p, g)));
if (!hits.length) process.exit(0);

const lines = [`=== vysu: ${hits.length} UI file(s) changed, check them on the real app ===`, ...hits.slice(0, 5).map((p) => `- ${p}`)];
if (hits.length > 5) lines.push(`- … and ${hits.length - 5} more`);
lines.push('web:    vysu walk <persona> <name> --url <origin>/<path> --baseline-url @   (then vysu report <name> --md)');
lines.push('mobile: recent and old device, then vysu textsize <platform> xl              (skill visual-check)');
process.stdout.write(`${lines.join('\n')}\n`);
