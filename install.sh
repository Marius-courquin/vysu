#!/usr/bin/env bash
# vysu installer — clones (or updates) the engine and puts `vysu` on the PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/Marius-courquin/vysu/main/install.sh | bash
#
# While the repository is private, the raw file above is not reachable: log in once with the GitHub
# CLI (`brew install gh && gh auth login`), then
#   gh repo clone Marius-courquin/vysu ~/vysu && ~/vysu/install.sh
#
# What it does, in order:
#   1. git clone https://github.com/Marius-courquin/vysu into $VYSU_INSTALL_DIR (default ~/vysu),
#      or `git pull` when it is already there;
#   2. checks node >= 22.6, which the engine runs on (TypeScript, no build step), and installs the
#      engine's own dependencies in its folder (`npm ci --omit=dev`: sharp, for sheets and diffs);
#   3. links bin/vysu into the first directory that is BOTH already on your PATH and writable
#      (/opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/bin) — no shell file is touched then;
#   4. otherwise appends a PATH line to your shell's startup file (zsh, bash or fish);
#   5. checks that `vysu version` answers, and says what to do next.
# Nothing else is installed here: `vysu setup` does the tools, and asks before creating devices.
# On Windows, install.ps1 does the same from PowerShell.
set -euo pipefail

REPO="${VYSU_REPO:-https://github.com/Marius-courquin/vysu}"
DIR="${VYSU_INSTALL_DIR:-$HOME/vysu}"

# The same three things a `vysu setup` line says, inlined: this script runs before the engine
# (src/core/ui.ts) exists on the machine. Markers are coloured only on a terminal, and NO_COLOR is
# honoured.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  M_OK=$'\033[32m✓\033[0m'; M_WARN=$'\033[33m!\033[0m'
  M_INFO=$'\033[2m·\033[0m'; H_ON=$'\033[1m'; H_OFF=$'\033[0m'
else
  M_OK='✓'; M_WARN='!'; M_INFO='·'; H_ON=''; H_OFF=''
fi
E_ON=''; E_OFF=''
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then E_ON=$'\033[31m'; E_OFF=$'\033[0m'; fi
OK_N=0; WARN_N=0
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s %s\n' "$M_OK" "$*"; OK_N=$((OK_N + 1)); }
warn() { printf '%s %s\n' "$M_WARN" "$*"; WARN_N=$((WARN_N + 1)); }
info() { printf '%s %s\n' "$M_INFO" "$*"; }
head_() { printf '\n%s## %s%s\n' "$H_ON" "$*" "$H_OFF"; }
# One red line for what went wrong, one plain line for what to run about it.
die() {
  printf '%sinstall: %s%s\n' "$E_ON" "$1" "$E_OFF" >&2
  [ $# -lt 2 ] || printf 'next: %s\n' "$2" >&2
  exit 1
}

# The one command that installs a missing tool on this machine: Homebrew on macOS, the
# distribution's package manager on Linux.
hint() { # git | node | gh
  if [ "$(uname)" = Darwin ]; then
    case "$1" in git) echo "xcode-select --install";; node) echo "brew install node";; gh) echo "brew install gh && gh auth login";; esac
  elif command -v apt-get >/dev/null; then
    case "$1" in
      git) echo "sudo apt-get install -y git";;
      node) echo "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs";;
      gh) echo "sudo apt-get install -y gh && gh auth login";;
    esac
  elif command -v dnf >/dev/null; then
    case "$1" in git) echo "sudo dnf install git";; node) echo "sudo dnf install nodejs";; gh) echo "sudo dnf install gh && gh auth login";; esac
  else
    case "$1" in git) echo "https://git-scm.com/downloads";; node) echo "https://nodejs.org/en/download (>= 22.6)";; gh) echo "https://cli.github.com";; esac
  fi
}

head_ "engine"
command -v git >/dev/null || die "git is missing" "$(hint git)"

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull -q --ff-only || die "cannot update the checkout in $DIR" "cd $DIR && git status"
  ok "engine: updated in $DIR"
elif [ -e "$DIR" ]; then
  die "$DIR exists and is not a vysu checkout" "VYSU_INSTALL_DIR=~/vysu-engine $0"
else
  # A private repository needs an authenticated clone: the GitHub CLI has the login when the
  # user ran `gh auth login`; plain git only has it when a credential helper or an SSH key is set.
  if [ -z "${VYSU_REPO:-}" ] && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh repo clone Marius-courquin/vysu "$DIR" -- -q 2>/dev/null \
      || die "cannot clone with gh — is your account a collaborator of Marius-courquin/vysu?" "gh auth status"
  else
    git clone -q "$REPO" "$DIR" 2>/dev/null \
      || die "cannot clone $REPO — no network, or the repository is private and this machine is not logged in" "$(hint gh)"
  fi
  ok "engine: cloned into $DIR"
fi
chmod +x "$DIR/bin/vysu"

# 2. The engine is TypeScript that Node runs as it is (type stripping: 22.18 and later, 22.6 with a flag
# bin/vysu.mjs adds), on its own
# node_modules: sharp, which every contact sheet and diff composes with.
head_ "node"
command -v node >/dev/null || die "node is missing — the engine runs on it (>= 22.6)" "$(hint node)"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 1)' \
  || die "node $(node --version) is below 22.6, which the engine needs" "$(hint node)"
ok "node: $(node --version)"
command -v npm >/dev/null || die "npm is missing — it comes with node" "$(hint node)"
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) \
  || die "npm ci --omit=dev failed in $DIR" "cd $DIR && npm ci --omit=dev"
ok "engine: dependencies installed (npm ci --omit=dev)"

# 3. A link in a directory the PATH already holds: the shell finds it without any startup file.
linked=""
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) continue;; esac
  [ -d "$d" ] && [ -w "$d" ] || continue
  ln -sfn "$DIR/bin/vysu" "$d/vysu" && linked="$d/vysu" && break
done

# 4. Else, the PATH line in the startup file of the shell the user actually runs.
rc=""; line="export PATH=\"$DIR/bin:\$PATH\""
if [ -z "$linked" ]; then
  case "$(basename "${SHELL:-}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc";;
    bash) if [ "$(uname)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi;;
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $DIR/bin";;
    *) rc="$HOME/.profile";;
  esac
  mkdir -p "$(dirname "$rc")"; touch "$rc"
  grep -qF "$DIR/bin" "$rc" || { printf '\n# vysu\n%s\n' "$line" >>"$rc"; }
  warn "path: $line — added to $rc, which this terminal has not read yet"
else
  ok "path: $linked → $DIR/bin/vysu"
fi

# 5. The proof, through the absolute path — the current shell has not re-read anything yet.
head_ "check"
if out="$("$DIR/bin/vysu" version 2>&1)"; then
  ok "$(printf '%s' "$out" | head -1)"
  # The two node drivers, which `vysu setup` installs right after this: a MISSING here is the
  # next thing to do, not a remark.
  while IFS= read -r l; do
    case "$l" in *MISSING*) warn "$l (vysu setup)";; *) info "$l";; esac
  done <<EOF
$(printf '%s\n' "$out" | tail -n +2)
EOF
else
  die "the engine does not answer: $out" "$DIR/bin/vysu version"
fi
if [ -n "$linked" ] && command -v vysu >/dev/null 2>&1; then
  ok "vysu is ready in this terminal"
else
  warn "vysu is not on this terminal's PATH yet — open a new terminal${rc:+, or: source $rc}"
fi

head_ "summary"
printf 'ready: %d · to do: %d\n' "$OK_N" "$WARN_N"
printf '\nnext:\n'
[ -n "$linked" ] || printf '  %-36s %s\n' "source $rc" "(or open a new terminal)"
printf '  %-36s %s\n' "vysu setup" "tools, browser, simulators, emulators"
printf '  %-36s %s\n' "cd <your project> && vysu init" "the .vysu/config of that project"
