#!/usr/bin/env bash
# Parity of `vysu update`: two clones of this engine behind a scratch origin that holds one newer
# commit (VERSION bumped, a CHANGELOG entry, package-lock.json touched), one updated by the reference
# engine (VYSU_REF, test/parity/README.md) and one by this one, on a branch and pinned at a detached
# commit. The reference updates the checkout it runs from, so its bin/vysu and lib/ are laid into its
# clone, untracked. Nothing leaves the scratch dir; the two node tools are only checked (they are at
# their minimum here).
#
#   VYSU_REF=<bash vysu> test/parity/update.sh <scratch dir>
set -uo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ENGINE/test/parity/ref.sh"
[ -d "$REF_DIR/lib" ] || { echo "VYSU_REF: no $REF_DIR/lib beside that vysu, which update.sh lays into a clone" >&2; exit 2; }
W="${1:?usage: test/parity/update.sh <scratch dir>}"
mkdir -p "$W"
W="$(cd "$W" && pwd -P)/update-$$"
mkdir -p "$W"
# A detached engine (a frozen checkout) gets a branch of its own in the scratch origin.
BRANCH="$(git -C "$ENGINE" symbolic-ref -q --short HEAD || echo parity-update)"
# This engine adds the dependency lines: when package-lock.json moved, it runs npm ci.
KNOWN='^· engine: package-lock.json changed|^✓ engine: dependencies installed'
FAILED=0

git clone -q --bare "$ENGINE" "$W/origin.git" || exit 2
git -C "$W/origin.git" fetch -q "$ENGINE" "+HEAD:refs/heads/$BRANCH" || exit 2
git clone -q --branch "$BRANCH" "$W/origin.git" "$W/work" || exit 2
(
  cd "$W/work" || exit 2
  git config user.email parity@example.com && git config user.name parity
  printf '9.9.9\n' > VERSION
  { printf '# Changelog\n\n## 9.9.9 — 2099-01-01\n\nA release that only exists in this test.\n\n'; tail -n +3 CHANGELOG.md; } > CHANGELOG.new && mv CHANGELOG.new CHANGELOG.md
  printf '\n' >> package-lock.json
  git commit -qam 'chore(release): 9.9.9' && git push -q origin "$BRANCH"
) || exit 2

for mode in branch detached; do
  for side in ref ts; do
    E="$W/$mode/$side/engine"
    git clone -q --branch "$BRANCH" "$W/origin.git" "$E" || exit 2
    if [ "$mode" = branch ]; then git -C "$E" reset -q --hard HEAD~1; else git -C "$E" checkout -q --detach HEAD~1; fi
    (cd "$E" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1)
    mkdir -p "$W/$mode/$side/proj"
    if [ "$side" = ref ]; then
      mkdir -p "$E/.parity-ref" && cp -R "$REF_DIR/lib" "$E/lib" && cp "$REF" "$E/.parity-ref/vysu"
      printf 'lib/\n.parity-ref/\n' >>"$E/.git/info/exclude"
      VYSU=("$E/.parity-ref/vysu")
    else VYSU=("$E/bin/vysu"); fi
    (cd "$W/$mode/$side/proj" && "${VYSU[@]}" update </dev/null) >"$W/$mode/$side/out" 2>"$W/$mode/$side/err"
    echo "exit $?" >>"$W/$mode/$side/out"
    git -C "$E" log --oneline -1 >>"$W/$mode/$side/out"
    git -C "$E" rev-parse --abbrev-ref HEAD >>"$W/$mode/$side/out"
  done
  norm() { sed -e "s#$W/$mode/$2#<W>#g" "$1" | grep -Ev "$KNOWN" || true; }
  ok=1
  diff <(norm "$W/$mode/ref/out" ref) <(norm "$W/$mode/ts/out" ts) >"$W/$mode.diff" || ok=0
  diff <(norm "$W/$mode/ref/err" ref) <(norm "$W/$mode/ts/err" ts) >>"$W/$mode.diff" || ok=0
  if [ "$ok" = 1 ]; then echo "same     update ($mode)"
  else FAILED=$((FAILED + 1)); echo "DIFFERS  update ($mode) ($W/$mode.diff)"; sed 's/^/    /' "$W/$mode.diff" | head -30; fi
  grep -E "$KNOWN" "$W/$mode/ts/out" | sed 's/^/    ts only: /'
done
echo "update parity: $FAILED different — $W"
[ "$FAILED" = 0 ]
