# checker.sh: the visual check as a delegated task: which model a checker sub-agent runs on, for
# whichever agent tool is asking, and the agent definition `vysu init` installs for the tools that
# read one. The principle (a short-context checker, a brief, a report contract) lives in the skill,
# where every agent reads it; only the model is tool-specific, so it is a project setting:
#   VYSU_CHECKER_MODELS='claude=sonnet,codex=gpt-5.6-luna'
# keyed by the agent family vysu already knows its caller by (`claude:41234` → claude).
# shellcheck shell=bash

checker_family() { # → the caller's agent family: the owner's name, lower-cased, without its pid
  local owner; owner="$(vysu_owner)"
  printf '%s' "${owner%%:*}" | tr '[:upper:]' '[:lower:]'
}
checker_model() { # family → the model the project names for it, or nothing (inherit the caller's)
  local pair IFS=,
  for pair in $(cfg CHECKER_MODELS); do
    pair="$(printf '%s' "$pair" | tr -d ' ')"
    [ "${pair%%=*}" != "$1" ] || { printf '%s' "${pair#*=}"; return; }
  done
}
vysu_checker() {
  local family=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --for) family="$2"; shift 2;;
      *) die "usage: vysu checker [--for <agent family>]";;
    esac
  done
  family="${family:-$(checker_family)}"
  local model; model="$(checker_model "$family")"
  echo "checker: delegate device and multi-screen checks to a sub-agent (brief and report: skill visual-check, references/delegate.md)"
  if [ -n "$model" ]; then
    echo "model for $family: $model (VYSU_CHECKER_MODELS, $(config_origin CHECKER_MODELS))"
  else
    echo "model for $family: inherit the caller's (VYSU_CHECKER_MODELS names none for $family)"
  fi
}

# The Claude Code agent definition, from the engine's template: the model is the project's claude
# entry, and a project that names none gets no `model:` line (the sub-agent inherits the caller's).
# Codex has no such file to read (its spawn_agent takes the model as an argument instead): the
# skill tells it to ask `vysu checker`.
checker_agent_install() { # target dir
  local src="$VYSU_ENGINE/templates/agents/visual-checker.md"
  [ -f "$src" ] || return 0
  mkdir -p "$1"
  local model; model="$(checker_model claude)"
  MODEL="$model" python3 - "$src" "$1/visual-checker.md" "$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo 0.0.0)" <<'PY'
import os, sys

src, dst, version = sys.argv[1], sys.argv[2], sys.argv[3]
model = os.environ["MODEL"]
out = []
for line in open(src):
    if line.startswith("model:"):
        if not model:
            continue
        line = "model: %s\n" % model
    out.append(line)
text = "".join(out)
# Stamped like the skills, after the frontmatter, so a stale copy can be told from a fresh one.
head, sep, body = text.partition("\n---\n")
open(dst, "w").write(head + sep + "<!-- vysu-agent %s -->\n" % version + body)
PY
  echo "installed agent: $1/visual-checker.md (model: ${model:-inherited})"
}
