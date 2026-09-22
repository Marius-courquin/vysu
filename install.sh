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
#   2. links bin/vysu into the first directory that is BOTH already on your PATH and writable
#      (/opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/bin) — no shell file is touched then;
#   3. otherwise appends a PATH line to your shell's startup file (zsh, bash or fish);
#   4. checks that `vysu version` answers, and says what to do next.
# Nothing else is installed here: `vysu setup` does the tools, and asks before creating devices.
set -euo pipefail

REPO="${VYSU_REPO:-https://github.com/Marius-courquin/vysu}"
DIR="${VYSU_INSTALL_DIR:-$HOME/vysu}"

# The same three things a `vysu setup` line says, inlined: this script runs before lib/ui.sh
# exists on the machine. Markers are coloured only on a terminal, and NO_COLOR is honoured.
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

head_ "engine"
command -v git >/dev/null || die "git is missing" "xcode-select --install"

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
      || die "cannot clone $REPO — no network, or the repository is private and this machine is not logged in" "brew install gh && gh auth login"
  fi
  ok "engine: cloned into $DIR"
fi
chmod +x "$DIR/bin/vysu"

# 2. A link in a directory the PATH already holds: the shell finds it without any startup file.
linked=""
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) continue;; esac
  [ -d "$d" ] && [ -w "$d" ] || continue
  ln -sfn "$DIR/bin/vysu" "$d/vysu" && linked="$d/vysu" && break
done

# 3. Else, the PATH line in the startup file of the shell the user actually runs.
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

# 4. The proof, through the absolute path — the current shell has not re-read anything yet.
head_ "check"
if out="$("$DIR/bin/vysu" version 2>&1)"; then
  ok "$(printf '%s' "$out" | head -1)"
  printf '%s\n' "$out" | tail -n +2 | while IFS= read -r l; do info "$l"; done
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
[ -n "$linked" ] || printf '  %s\n' "source $rc                          (or open a new terminal)"
printf '  %s\n' "vysu setup                          tools, browser, simulators, emulators"
printf '  %s\n' "cd <your project> && vysu init      the .vysu/config of that project"
