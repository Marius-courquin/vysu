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

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is missing (macOS: xcode-select --install)"

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull -q --ff-only && say "engine: updated in $DIR"
elif [ -e "$DIR" ]; then
  die "$DIR exists and is not a vysu checkout (set VYSU_INSTALL_DIR to another folder)"
else
  # A private repository needs an authenticated clone: the GitHub CLI has the login when the
  # user ran `gh auth login`; plain git only has it when a credential helper or an SSH key is set.
  if [ -z "${VYSU_REPO:-}" ] && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh repo clone Marius-courquin/vysu "$DIR" -- -q 2>/dev/null || die "cannot clone with gh — is your account a collaborator of Marius-courquin/vysu?"
  else
    git clone -q "$REPO" "$DIR" 2>/dev/null || die "cannot clone $REPO — no network, or the repository is private and this machine is not logged in: brew install gh && gh auth login, then run this again"
  fi
  say "engine: cloned into $DIR"
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
  say "path: $line  (added to $rc)"
else
  say "path: $linked → $DIR/bin/vysu"
fi

# 4. The proof, through the absolute path — the current shell has not re-read anything yet.
say "check: $("$DIR/bin/vysu" version)"
say ""
if [ -n "$linked" ] && command -v vysu >/dev/null 2>&1; then
  say "vysu is ready in this terminal."
else
  say "Open a NEW terminal (or run: source $rc), then check with: vysu version"
fi
say "Next: vysu setup          (tools, browser, simulators and emulators — asks before creating devices)"
say "      cd <your project> && vysu init"
