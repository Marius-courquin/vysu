# example — the template a project copies to `.vysu/auth.sh` and fills in. It logs into an app whose
# door is a page of its own, with the five functions the engine calls and the primitives it offers;
# every line is there to be replaced, and the comments say what the engine expects back.
#
# Copy it, then check it with `vysu auth test <persona>`:
#   cp "$VYSU_ENGINE/connectors/auth/example.sh" .vysu/auth.sh
#
# Options: a connector reads its own through `cfg <NAME>_<KEY> <default>`, which is the config key
# VYSU_<NAME>_<KEY>. Document them here, with their defaults in brackets, the way the built-ins do:
#   VYSU_MYAPP_SIGNIN_LABELS [Se connecter,Sign in]   the door's button
#   VYSU_MYAPP_HOME_TEXT     [Bienvenue]              the text that proves the login held
# shellcheck shell=bash

myapp_opt() { cfg "MYAPP_$1" "$2"; }
# A comma-separated option as arguments: a label list is written the way a human reads it.
# shellcheck disable=SC2086  # splitting on the comma is the point: one label per line
myapp_labels() { local IFS=,; printf '%s\n' $1; }

# One line for `vysu doctor`: which system this talks to, and the options that are set.
auth_describe() {
  printf 'example: a form on the app itself (sign-in: %s)' "$(myapp_opt SIGNIN_LABELS 'Se connecter,Sign in')"
}

# The browser session is open and is the persona's own; return with the page logged in on the url's
# origin. `step` prints under `vysu auth test` and stays silent the rest of the time.
auth_web_login() { # persona url
  local persona="$1" url="$2"
  # Sets $PERSONA_EMAIL and $PERSONA_PASSWORD, and dies with the command to run when the persona
  # is not in personas.env. Any other key: persona_var "$persona" TOTP_SECRET.
  persona_require "$persona"

  web "$persona" open "$url" >/dev/null
  step "open $url"
  # A field by its label, then by its placeholder: how a form says what a box is for.
  web "$persona" find label "E-mail" fill "$PERSONA_EMAIL" >/dev/null 2>&1 \
    || web "$persona" fill 'input[type=email]' "$PERSONA_EMAIL" >/dev/null \
    || die "login: no e-mail field on $url"
  web "$persona" fill 'input[type=password]' "$PERSONA_PASSWORD" >/dev/null \
    || die "login: no password field on $url"
  step "fill the credentials"
  # The first visible button among several names: a label differs by language and by version.
  # shellcheck disable=SC2046  # the label list is meant to become several arguments
  web_click_any "$persona" $(myapp_labels "$(myapp_opt SIGNIN_LABELS 'Se connecter,Sign in')") \
    || die "login: no sign-in button on $url (VYSU_MYAPP_SIGNIN_LABELS)"
  step "submit"
  # Proof, not a delay: something only the logged-in app shows.
  web "$persona" wait --text "$(myapp_opt HOME_TEXT 'Bienvenue')" >/dev/null \
    || die "login: never reached the home screen (VYSU_MYAPP_HOME_TEXT)"
  step "reach the home screen"
  echo "logged in: $persona ($PERSONA_EMAIL) → $(web "$persona" get url | tail -1)"
}

# The API access token of the session as it stands, on stdout and nothing else. Printing nothing is
# a valid answer: an app whose session is a cookie no script can read has no token to give.
auth_web_token() { # persona
  web "$1" eval "localStorage.getItem('access_token') || ''" | tail -1 | tr -d '"'
}

# The app is installed and may be anywhere: on its door, signed in as someone else, or on a
# dev-client launcher. Return with it logged in as the persona, on its home screen.
auth_mobile_login() { # platform persona
  local platform="$1" persona="$2"
  persona_require "$persona"
  local app; app="$(mobile_app "$platform")"
  [ -n "$app" ] || die "mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set"
  # Killed and started again straight onto its bundle, on its root screen, whatever it was left on;
  # vysu ends here, with the reason, when the app cannot start.
  mobile_relaunch "$platform"
  step "open $app"

  # A system dialog that may or may not be there, in whatever language the device is in.
  mob_press_any "$platform" "Autoriser,Allow" || true
  mob_press_if "$platform" "$(myapp_opt SIGNIN_LABELS 'Se connecter')" >/dev/null 2>&1 || true

  # Fields by accessibility label, with the roles as the fallback.
  mob "$platform" fill 'role="textfield"' "$PERSONA_EMAIL" >/dev/null \
    || die "$platform: no e-mail field on the login screen"
  mob "$platform" fill 'role="securetextfield"' "$PERSONA_PASSWORD" >/dev/null \
    || die "$platform: no password field on the login screen"
  mob "$platform" keyboard return >/dev/null
  step "fill the credentials"

  # A login inside a system web surface (SafariViewService, a Chrome Custom Tab) is invisible to the
  # platform's accessibility: there, the fields are read from the picture instead of guessed at.
  #   boxes="$(mob_fields "$platform")"   # [{"x":…,"y":…,"w":…,"h":…}] in points, top to bottom
  #   mob "$platform" press <x> <y>

  mob_wait_text "$platform" "$(myapp_opt HOME_TEXT 'Bienvenue')" 30000 \
    || die "$platform: never reached the home screen (VYSU_MYAPP_HOME_TEXT)"
  step "reach the home screen"
  # One install is one session: the next agent reads who it holds from `vysu claim`.
  mstate_set "$platform" persona "$persona"
  echo "$platform: logged in as $persona ($PERSONA_EMAIL)"
}

# Optional: `mlogin` calls it when another persona is signed in. `{ : ; }` when the app has no way out.
auth_mobile_logout() { # platform
  local platform="$1" out; out="$(myapp_opt LOGOUT_LABEL 'Se déconnecter')"
  # The menu first, then its logout row once it shows: a row pressed while its menu is still closed
  # (or opening) taps whatever lies under it.
  mob_press_if "$platform" "$(myapp_opt MENU_LABEL Menu)" >/dev/null 2>&1 \
    && mob_wait_text "$platform" "$out" 5000 >/dev/null 2>&1 \
    && mob_press_if "$platform" "$out" >/dev/null 2>&1
}
