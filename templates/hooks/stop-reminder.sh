#!/usr/bin/env bash
# vysu Stop hook — reminds you to check the UI on the real app when UI files changed.
#
# It only prints: it runs no capture, changes nothing, and is agent-agnostic (any tool that can
# run a script at the end of a turn can use it; Claude Code reads its stdout).
#
# Install (Claude Code): copy it into the project, make it executable, and add it as a `Stop` hook
# command in .claude/settings.json. Run it by hand to see what it would say.
#
# Which files count as UI comes from VYSU_UI_GLOBS, comma-separated, matched against the paths
# `git status --porcelain` reports (a leading `**/` matches at any depth):
#   default: **/*.tsx,**/*.vue,**/*.svelte,**/*.css
# Set it in the environment, or in the project's .vysu/config (VYSU_UI_GLOBS='src/**/*.tsx,…').
set -u
[ -t 0 ] || cat >/dev/null 2>&1   # the hook payload arrives on stdin and is not needed here

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" 2>/dev/null || exit 0

globs="${VYSU_UI_GLOBS:-}"
if [ -z "$globs" ] && [ -f .vysu/config ]; then
  globs=$(sed -n "s/^[[:space:]]*VYSU_UI_GLOBS=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}[[:space:]]*$/\1/p" .vysu/config | tail -1)
fi
globs="${globs:-**/*.tsx,**/*.vue,**/*.svelte,**/*.css}"

# -uall: an untracked folder is otherwise reported as the folder, and no glob would ever match it.
changed=$(git status --porcelain -uall 2>/dev/null | sed 's/^...//; s/^.* -> //; s/^"//; s/"$//') || exit 0
[ -n "$changed" ] || exit 0

patterns=$(printf '%s' "$globs" | tr ',' '\n')
hits=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  while IFS= read -r glob; do
    [ -n "$glob" ] || continue
    # `**/x` means « x at any depth », which a plain `*` already does against a whole path.
    # shellcheck disable=SC2254  # the config's globs are meant to be globs, not literals
    case "$path" in
      ${glob#\*\*/}|$glob) hits="$hits$path
"; break;;
    esac
  done <<PATTERNS
$patterns
PATTERNS
done <<EOF
$changed
EOF

[ -n "$hits" ] || exit 0

count=$(printf '%s' "$hits" | grep -c .)
echo "=== vysu: $count UI file(s) changed, check them on the real app ==="
printf '%s' "$hits" | head -5 | sed 's/^/- /'
[ "$count" -le 5 ] || echo "- … and $((count - 5)) more"
echo "web:    vysu walk <persona> <name> --url <origin>/<path> --baseline-url @   (then vysu report <name> --md)"
echo "mobile: recent and old device, then vysu textsize <platform> xl              (skill visual-check)"
exit 0
