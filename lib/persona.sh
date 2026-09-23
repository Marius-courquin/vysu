# persona.sh — the project's personas: the `personas.env` file under $VYSU_STATE (mode 600), the
# `VYSU_PERSONA_<NAME>_<KEY>` lookup every connector and driver reads its credentials through, and
# `vysu persona add | set | list | import`. Nothing here ever prints a password.
# shellcheck shell=bash

load_personas() {
  [ -f "$PERSONAS" ] || die "no $PERSONAS (vysu persona add <name>)"
  set -a
  # shellcheck disable=SC1090  # the user's own credentials file, its path resolved at runtime
  . "$PERSONAS"
  set +a
}
persona_var() { # persona KEY → value
  local key; key="VYSU_PERSONA_$(echo "$1" | tr '[:lower:]' '[:upper:]')_$2"
  printf '%s' "${!key:-}"
}
# The credentials a login needs, loaded and checked in one place: every connector starts here.
persona_require() { # persona → sets PERSONA_EMAIL / PERSONA_PASSWORD
  load_personas
  PERSONA_EMAIL="$(persona_var "$1" EMAIL)"
  PERSONA_PASSWORD="$(persona_var "$1" PASSWORD)"
  [ -n "$PERSONA_EMAIL" ] && [ -n "$PERSONA_PASSWORD" ] || die "persona '$1' not in $PERSONAS (vysu persona add $1)"
}
persona_names() { # the personas the file declares, one per line (names may hold `_`: py/personas.py)
  [ -f "$PERSONAS" ] || return 0
  python3 "$PY/personas.py" names "$PERSONAS"
}
# A name is part of a variable name: `tb-x` or `tb.x` would write a line bash cannot source.
persona_check_name() {
  [[ "$1" =~ ^[A-Za-z0-9_]+$ ]] || die "persona '$1': letters, digits and _ only (the name is part of a variable name)"
}
# A key is written once and rewritten in place: the file stays readable, and a `set` never leaves
# two lines for the same variable behind.
persona_write() { # KEY value
  mkdir -p "$(dirname "$PERSONAS")"
  touch "$PERSONAS"; chmod 600 "$PERSONAS"
  { grep -v "^$1=" "$PERSONAS" || true; printf '%s=%s\n' "$1" "$2"; } >"$PERSONAS.tmp"
  mv "$PERSONAS.tmp" "$PERSONAS"; chmod 600 "$PERSONAS"
}
persona_key() { # persona KEY → the variable name
  printf 'VYSU_PERSONA_%s_%s' "$(echo "$1" | tr '[:lower:]' '[:upper:]')" "$(echo "$2" | tr '[:lower:]' '[:upper:]')"
}

vysu_persona() {
  local verb="${1:-}"; shift || true
  case "$verb" in
    add) persona_add "$@";;
    set) persona_set "$@";;
    list) persona_list "$@";;
    import) persona_import "$@";;
    *) die "usage: vysu persona add <name> | set <name> <KEY> <value> | list [--json] | import <file> [--prefix <P>] [--to <file>]";;
  esac
}
# Interactive on purpose: a password typed into a prompt is not in the shell history, not in an
# agent's transcript and not in a process list.
persona_add() {
  need_project
  local name="${1:-}"; [ -n "$name" ] || die "usage: vysu persona add <name>"
  persona_check_name "$name"
  local email password
  printf 'e-mail for %s: ' "$name" >&2; IFS= read -r email
  [ -n "$email" ] || die "persona add: no e-mail"
  printf 'password for %s (not echoed): ' "$name" >&2
  # `read -s` is bash 3.2's own silent read; the newline it swallows is printed back.
  IFS= read -rs password; printf '\n' >&2
  [ -n "$password" ] || die "persona add: no password"
  persona_write "$(persona_key "$name" EMAIL)" "$email"
  persona_write "$(persona_key "$name" PASSWORD)" "$password"
  echo "persona $name: $email → $PERSONAS (mode 600)"
}
# Any other key a connector or a driver reads: an FCM token, an auth id, a residence — free-form
# on purpose, since only the project knows what its own commands need.
persona_set() {
  need_project
  local name="${1:-}" key="${2:-}" value="${3:-}"
  { [ -n "$name" ] && [ -n "$key" ]; } || die "usage: vysu persona set <name> <KEY> <value>"
  persona_check_name "$name"
  persona_write "$(persona_key "$name" "$key")" "$value"
  case "$(echo "$key" | tr '[:lower:]' '[:upper:]')" in
    PASSWORD|*TOKEN|*SECRET) echo "persona $name: $key set";;
    *) echo "persona $name: $key = $value";;
  esac
}
# Names and the non-secret keys, never a value that reads as a credential: `--json` is what a
# project command consumes (`vysu persona list --json`).
persona_list() {
  local json=0; [ "${1:-}" != "--json" ] || json=1
  if [ ! -f "$PERSONAS" ]; then
    # A consumer asking for JSON gets an empty list, not a failure: no persona yet is an answer.
    [ "$json" = 1 ] || die "no $PERSONAS (vysu persona add <name>)"
    echo '[]'; return
  fi
  if [ "$json" = 1 ]; then python3 "$PY/personas.py" list "$PERSONAS" --json
  else python3 "$PY/personas.py" list "$PERSONAS"; fi
}
# The one-off that replaces a vault: an existing env file of credentials, whatever its prefix, read
# into this project's personas. `--to` writes elsewhere than the state folder, which is how a
# converted file is tried before it is adopted.
persona_import() {
  local file="${1:-}"; [ -n "$file" ] || die "usage: vysu persona import <file> [--prefix <P>] [--to <file>]"
  shift
  [ -f "$file" ] || die "no file $file"
  local prefix="" to="$PERSONAS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --prefix) prefix="$2"; shift 2;;
      --to) to="$2"; shift 2;;
      *) die "vysu persona import: unknown option $1";;
    esac
  done
  # Keys that belong to no persona (a fixture id kept next to the credentials) are named and left
  # behind: they are the project's config, not anyone's credentials.
  python3 "$PY/personas.py" import "$file" "$to" --prefix "$prefix" || die "persona import: could not read $file"
}
