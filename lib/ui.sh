# ui.sh — the three things a report line is allowed to say, and no fourth: it is fine (with the
# version), it is missing and optional (what it unlocks, and the command), it is missing and
# required (the command). `summary` counts them and repeats every command in one block, so the
# reader of `vysu setup` never has to work out what was blocking and what was noise.
#
# Sourced first by bin/vysu — core.sh's `die` paints itself with E_ON / E_OFF from here — and
# inlined by install.sh, which runs before this file exists on the machine.
# shellcheck shell=bash

# Colours only when the stream is a terminal, NO_COLOR is unset (https://no-color.org) and
# `--no-color` / VYSU_NO_COLOR were not given. Decided once, per stream: stdout carries the report,
# stderr carries `die`.
UI_COLOR=1
case "${VYSU_NO_COLOR:-}" in ''|0|no|false) ;; *) UI_COLOR=0;; esac
# shellcheck disable=SC2034  # E_ON / E_OFF are read by core.sh's `die`, which was sourced after
ui_colors() {
  if [ "$UI_COLOR" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
    M_OK=$'\033[32m✓\033[0m'; M_WARN=$'\033[33m!\033[0m'; M_MISS=$'\033[31m✗\033[0m'
    M_INFO=$'\033[2m·\033[0m'; H_ON=$'\033[1m'; H_OFF=$'\033[0m'
  else
    M_OK='✓'; M_WARN='!'; M_MISS='✗'; M_INFO='·'; H_ON=''; H_OFF=''
  fi
  if [ "$UI_COLOR" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ -t 2 ]; then
    E_ON=$'\033[31m'; E_OFF=$'\033[0m'
  else
    E_ON=''; E_OFF=''
  fi
}
ui_no_color() { UI_COLOR=0; ui_colors; }
ui_colors

# What the summary counts, and the commands it repeats. `ui_reset` is for a process that reports
# twice (setup then doctor in the same shell); nothing in the engine does yet.
UI_OK=0; UI_WARN=0; UI_MISS=0; UI_TODO=""
ui_reset() { UI_OK=0; UI_WARN=0; UI_MISS=0; UI_TODO=""; }

# « <text> -- <command> »: everything before the separator is what the reader is told, everything
# after is the one command that fixes it. The command is kept whole — a caller passes it as a
# single quoted argument — and goes into the summary block as well as onto the line.
UI_TEXT=""; UI_CMD=""
ui_split() {
  UI_TEXT=""; UI_CMD=""; local after=0 arg
  for arg in "$@"; do
    if [ "$after" = 1 ]; then UI_CMD="${UI_CMD:+$UI_CMD }$arg"; continue; fi
    if [ "$arg" = "--" ]; then after=1; continue; fi
    UI_TEXT="${UI_TEXT:+$UI_TEXT }$arg"
  done
}
# The same command named by three lines is one line to run: the block is a list of what to do,
# not a tally of what is wrong.
ui_todo() {
  [ -n "$1" ] || return 0
  case "
$UI_TODO
" in *"
$1
"*) return 0;; esac
  UI_TODO="${UI_TODO:+$UI_TODO
}$1"
}

# shellcheck disable=SC2034  # UI_TEXT / UI_CMD are set by ui_split, read right after
ok()   { ui_split "$@"; printf '%s %s\n' "$M_OK" "$UI_TEXT"; UI_OK=$((UI_OK + 1)); }
warn() { ui_split "$@"; printf '%s %s%s\n' "$M_WARN" "$UI_TEXT" "${UI_CMD:+ → $UI_CMD}"; ui_todo "$UI_CMD"; UI_WARN=$((UI_WARN + 1)); }
miss() { ui_split "$@"; printf '%s %s%s\n' "$M_MISS" "$UI_TEXT" "${UI_CMD:+ → $UI_CMD}"; ui_todo "$UI_CMD"; UI_MISS=$((UI_MISS + 1)); }
info() { printf '%s %s\n' "$M_INFO" "$*"; }
# Not `head`: a bash function of that name would shadow the tool in every « … | head -1 » the
# engine runs, and there are a dozen of them.
ui_head() { printf '\n%s## %s%s\n' "$H_ON" "$*" "$H_OFF"; }

summary() { # [next step]… — the counts, the commands, then what only the reader can do
  ui_head "summary"
  printf 'ready: %d · optional missing: %d · required missing: %d\n' "$UI_OK" "$UI_WARN" "$UI_MISS"
  if [ -n "$UI_TODO" ]; then
    printf '\nrun:\n'
    printf '%s\n' "$UI_TODO" | sed 's/^/  /'
  fi
  if [ $# -gt 0 ]; then
    printf '\nnext:\n'
    local step
    for step in "$@"; do printf '  %s\n' "$step"; done
  fi
}
# The exit status of a report: a required tool missing is a failure, an optional one is not.
ui_status() { [ "$UI_MISS" = 0 ]; }
