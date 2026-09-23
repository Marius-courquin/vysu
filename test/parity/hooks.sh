#!/usr/bin/env bash
# Parity of the Stop hook: templates/hooks/stop-reminder.sh and its portable twin stop-reminder.mjs on
# the same scratch repository (modified, renamed, untracked, spaced paths), with the default globs,
# VYSU_UI_GLOBS from the environment, from .vysu/config, and CLAUDE_PROJECT_DIR from elsewhere.
#
#   test/parity/hooks.sh <scratch dir>
set -uo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
W="${1:?usage: test/parity/hooks.sh <scratch dir>}"
mkdir -p "$W"
R="$(cd "$W" && pwd -P)/hooks-$$"
mkdir -p "$R/repo"
cd "$R/repo" || exit 2
git init -q
mkdir -p src/deep/x "sp ace" .vysu
touch a.tsx src/b.tsx src/deep/x/c.vue d.css e.ts "sp ace/f.svelte" src/g.tsx src/h.tsx src/i.tsx
git add -A && git -c user.email=parity@example.com -c user.name=parity commit -qm init
echo x >> a.tsx; git mv src/b.tsx src/b2.tsx; touch src/deep/new.tsx "sp ace/g h.css"; echo 1 >> e.ts
for f in src/g.tsx src/h.tsx src/i.tsx; do echo 2 >> "$f"; done
FAILED=0

both() { # label, then the environment assignments
  local label="$1"; shift
  (echo '{"hook":"Stop"}' | env "$@" bash "$ENGINE/templates/hooks/stop-reminder.sh") >"$R/sh.out"; echo "exit $?" >>"$R/sh.out"
  (echo '{"hook":"Stop"}' | env "$@" node "$ENGINE/templates/hooks/stop-reminder.mjs") >"$R/mjs.out"; echo "exit $?" >>"$R/mjs.out"
  if diff "$R/sh.out" "$R/mjs.out" >"$R/$label.diff"; then echo "same     $label ($(grep -c '^- ' "$R/sh.out") listed)"
  else FAILED=$((FAILED + 1)); echo "DIFFERS  $label"; sed 's/^/    /' "$R/$label.diff"; fi
}
both default
both env-globs "VYSU_UI_GLOBS=src/**/*.tsx,*.css"
printf "VYSU_UI_GLOBS='*.ts'\n" > .vysu/config; both config-globs
printf 'VYSU_UI_GLOBS="x.nomatch"\n' > .vysu/config; both config-nomatch
rm -f .vysu/config
cd / || exit 2
both project-dir "CLAUDE_PROJECT_DIR=$R/repo"
both not-a-repo "CLAUDE_PROJECT_DIR=$R"
echo "hooks parity: $FAILED different — $R"
[ "$FAILED" = 0 ]
