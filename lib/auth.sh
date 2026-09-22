# auth.sh — the auth connector: which one the project named, the primitives it is allowed to call,
# and the commands that go through it — `login`, `mlogin`, `auth token`, `auth test`. A connector is
# a bash file sourced here, so one written for an app runs unchanged on another machine.
# shellcheck shell=bash

# Primitives a connector may call, all defined elsewhere and listed here so the contract is one
# place: web / web_click_any (web.sh), mob / mob_press_if / mob_press_any / mob_wait_text /
# mob_fields (mobile.sh), persona_require / persona_var (persona.sh), cfg / die / log (core.sh),
# and `step` below. The contract itself, with what each one leaves behind, is in
# connectors/auth/README.md; connectors/auth/example.sh is the template a project copies.
AUTH_LOADED=""
auth_load() {
  [ -z "$AUTH_LOADED" ] || return 0
  local named file; named="$(cfg AUTH)"
  # A project that dropped an auth.sh in `.vysu/` and named no connector means that one.
  if [ "$(config_origin AUTH)" = default ] && [ -n "$VYSU_PROJECT_DIR" ] && [ -f "$VYSU_PROJECT_DIR/.vysu/auth.sh" ]; then
    named=custom
  fi
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
auth_describe_line() { # for doctor: the connector's own one-liner, and whether anyone chose it
  local named; named="$(cfg AUTH)"
  if [ "$named" = none ] && [ "$(config_origin AUTH)" = default ]; then
    echo "auth: none (default)"; return
  fi
  auth_load
  echo "auth: $AUTH_LOADED — $(auth_describe)"
}
# What a connector says as it goes. Silent outside `vysu auth test`, so a login prints the one line
# it always printed and a test reads as the list of what held.
AUTH_STEPS=0
step() { # "<what just worked>"
  [ "$AUTH_STEPS" = 1 ] || return 0
  echo "step: $* ok"
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
    test) auth_test "$@";;
    *) die "usage: vysu auth token <persona> | test <persona> [ios|android] | describe";;
  esac
}

# --- auth test ----------------------------------------------------------------------------------

# The web test runs on a session of its own — its own profile, no cookie of the persona's real
# session — so a connector is exercised the way a first login sees it, and the real session is
# neither consumed nor left half logged in. The session is closed whichever way this ends: the
# EXIT trap in core.sh calls auth_test_close.
auth_test_close() {
  [ -n "${AUTH_TEST_SESSION:-}" ] || return 0
  local session="$AUTH_TEST_SESSION"
  AUTH_TEST_SESSION=""   # every `ab` from here on is a normal one again, close included
  agent-browser --session "$session" close >/dev/null 2>&1 || true
  # The restore file is what would carry a login into the next test: it goes with the session.
  rm -f "$HOME/.agent-browser/sessions/$session-$session.json"
}

auth_test() { # <persona> [ios|android]
  local persona="${1:-}" platform="${2:-}"
  [ -n "$persona" ] || die "usage: vysu auth test <persona> [ios|android]"
  auth_load
  AUTH_STEPS=1
  echo "auth test: $AUTH_LOADED — $(auth_describe)"
  if [ -n "$platform" ]; then
    case "$platform" in ios|android) ;; *) die "vysu auth test: the platform is ios or android";; esac
    # One install is one session: there is no throwaway device, and the test logs the persona in
    # for real — which also rotates whatever the identity provider rotates on a login.
    echo "device: the real $platform app (one install = one session): this logs $persona in for good"
    auth_mobile_login "$platform" "$persona"
    step "mobile login as $persona"
    echo "auth test: ok"
    return 0
  fi
  local origin url
  origin="$(need_cfg ORIGIN "the app's web origin")"
  url="${origin%/}$(cfg LOGIN_PATH)"
  AUTH_TEST_SESSION="$(cfg PROJECT)-authtest"
  auth_test_close_state
  echo "session: $AUTH_TEST_SESSION (throwaway, no cookies)"
  auth_web_login "$persona" "$url"
  step "web login as $persona"
  local landed; landed="$(web "$persona" get url 2>/dev/null | tail -1)"
  echo "url: ${landed:-(unknown)}"
  local token; token="$(auth_web_token "$persona" 2>/dev/null || true)"
  if [ -n "$token" ]; then
    # Never the token itself: what a test has to prove is that the connector can find one.
    step "auth token (${#token} characters)"
  else
    echo "token: none (this connector exposes none)"
  fi
  auth_test_close
  echo "auth test: ok"
}
# A throwaway session that a killed run left behind still holds its restore file: drop it before
# the test rather than after, so « no cookies » is true even then.
auth_test_close_state() {
  rm -f "$HOME/.agent-browser/sessions/$AUTH_TEST_SESSION-$AUTH_TEST_SESSION.json"
  # Only when one is actually running: closing a session that is not there starts a daemon just to
  # stop it, and that shutdown lands on the browser the test opens a second later — the page comes
  # back blank half way through the login, which is a long way from where the real fault is.
  agent-browser session list 2>/dev/null | grep -q "$AUTH_TEST_SESSION\$" || return 0
  agent-browser --session "$AUTH_TEST_SESSION" close >/dev/null 2>&1 || true
}
