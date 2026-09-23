# Delegating a visual check

The developing agent carries a long context: every device round trip re-reads it. A checker
sub-agent starts at a few thousand tokens, drives the app, and hands back a short text report and
one sheet. Measured on 62 sessions of one project: 386k tokens of context per device round trip in
the developing session, 185k in a sub-agent, and less again for a sub-agent without MCP servers
or unrelated skills. A fresh checker also beats continuing an old one: resumed at 363k, a checker
cost twice what a new one cost for the same screen.

## Who judges what

- The **checker** drives, captures and reports **facts**: what is on screen, what changed against
  the previous capture or the baseline, what the logs and the network say, what it could not reach.
  A small fast model is enough for that.
- The **caller** judges the design on the sheet it gets back (one image) and decides.

## Which model

Model names belong to each agent tool, so the skill names none: `vysu checker` prints the one the
project chose for the tool that asks (`VYSU_CHECKER_MODELS='claude=sonnet,codex=…'`, the family
being the caller vysu detects, `claude:41234` → `claude`), or « inherit » when the project chose
none. Spawn the checker with that model: the `model` of Claude Code's Agent tool, the `model` of
Codex's `spawn_agent`, the equivalent elsewhere.

## The brief (fill every heading; a missing answer costs the checker round trips)

```markdown
Goal: <one sentence: what to verify and why>
Changed: <files / components touched> - expected on screen: <what should now look different, where>
Screens: <web urls | mobile routes for `vysu mopen` | how to reach them from the home screen>
Persona(s): <names from `vysu persona list`, and what each one is for here>
Devices: <web sizes | "claim --any" per platform | exact devices>; text sizes: <normal,xl>; theme: <light|dark>
States: <empty / long names / error / offline / permission denied / skeleton: how to get each one>
Interactions: <gestures to record with mrec/rec: drag the header, pull to refresh, open the sheet…>
Mode: shared (default) | isolated (`vysu up <platform> --isolated` from <worktree>)
Budget: <max images to read, e.g. 12>; stop and report when a device is not available for 10 min
Shots folder: <name> (captures go there, then `vysu sheet <name>`)
Report: the contract below, 400 words max
```

Mechanics the checker already knows from this skill: claim a device (`--any`), one `mdo` per
screen or state, `wait` instead of `sleep`, `mlog --errors` before concluding, `release --reset`.

## The report contract (what the checker returns)

```markdown
Verdict: OK | defects | not verified (<why>)
Screens:
- <screen> · <device> · <textsize> : OK | defect <n> | not reached (<why>)
Defects:
1. <what is wrong, where (zone in points), on which device/size> - evidence: <capture path>
Changes vs previous / baseline: <zones changed on which captures; "unchanged" is reported as such>
Logs: <errors from mlog --errors / check, or "clean">
Sheet: <path of the one image the caller should read>
Not covered: <states, devices or gestures skipped, and why>
Devices: released and reset (<list>)
```

No narration of the steps, no commands, no advice on the code unless asked: the caller has the
code and the context.

## Agent definitions

`vysu init` installs `visual-checker.md` into `.claude/agents/` (or `--agents-dir`): a Claude Code
sub-agent limited to the shell and file reading (no MCP servers: their tool list alone weighs
thousands of tokens on every call), on the model `VYSU_CHECKER_MODELS` names for `claude`, whose
instructions are this contract. `vysu init --refresh-skills` refreshes it with the skills. A
project overlay may ship its own instead (its personas, devices and routes). Codex reads no such
file today: it spawns a sub-agent with this brief and the model `vysu checker` gives it. An agent
with no sub-agents at all (or a human) runs the brief as a checklist.
