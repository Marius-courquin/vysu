# auth.sh — the auth connector: which one the project named, the primitives it is allowed to call,
# and the three commands that go through it — `login`, `mlogin`, `auth token`. A connector is a
# bash file sourced here, so one written for an app runs unchanged on another machine.
# shellcheck shell=bash

# Primitives a connector may call, all defined elsewhere and listed here so the contract is one
# place: web / web_click_any (web.sh), mob / mob_press_if / mob_wait_text (mobile.sh),
# persona_var (persona.sh), cfg / die / log (core.sh).
AUTH_LOADED=""
auth_load() {
  [ -z "$AUTH_LOADED" ] || return 0
  local named file; named="$(cfg AUTH)"
  if [ -z "$named" ] && [ -n "$VYSU_PROJECT_DIR" ] && [ -f "$VYSU_PROJECT_DIR/.vysu/auth.sh" ]; then
    named=custom
  fi
  [ -n "$named" ] || { need_project; die "VYSU_AUTH is not set (a built-in connector name, or a path)"; }
  case "$named" in
    custom) file="$VYSU_PROJECT_DIR/.vysu/auth.sh";;
    */*) file="$(project_path "$named")";;
    *) file="$VYSU_ENGINE/connectors/auth/$named.sh";;
  esac
  [ -f "$file" ] || die "no auth connector « $named » ($file)"
  # shellcheck disable=SC1090  # the connector the project named, resolved at runtime
  . "$file"
  AUTH_LOADED="$named"
}
auth_describe_line() { # for doctor: the connector's own one-liner, or why there is none
  local named; named="$(cfg AUTH)"
  [ -n "$named" ] || { echo "auth: (none — VYSU_AUTH is not set)"; return; }
  auth_load
  echo "auth: $AUTH_LOADED — $(auth_describe)"
}

vysu_login() {
  local persona="${1:-}"; [ -n "$persona" ] || die "usage: vysu login <persona> [url]"
  local url="${2:-}"
  if [ -z "$url" ]; then
    local origin; origin="$(need_cfg ORIGIN "the app's web origin")"
    url="${origin%/}$(cfg LOGIN_PATH)"
  fi
  auth_load
  auth_web_login "$persona" "$url"
}

vysu_mlogin() {
  local platform="${1:-}" persona="${2:-}"
  [ -n "$platform" ] && [ -n "$persona" ] || die "usage: vysu mlogin ios|android <persona>"
  auth_load
  auth_mobile_login "$platform" "$persona"
}

vysu_auth() {
  local verb="${1:-}"; shift || true
  case "$verb" in
    token)
      local persona="${1:-}"; [ -n "$persona" ] || die "usage: vysu auth token <persona>"
      auth_load
      auth_web_token "$persona";;
    describe) auth_load; auth_describe;;
    *) die "usage: vysu auth token <persona> | describe";;
  esac
}
