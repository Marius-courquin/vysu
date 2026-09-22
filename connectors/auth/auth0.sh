# auth0 — Auth0 Universal Login, identifier-first: e-mail on one page, password on the next, each
# carrying two submit buttons (one hidden) so the visible one is found by role and name. The token
# is read out of the auth0-spa-js cache in localStorage. On mobile the login runs in a system web
# surface (SafariViewService / Chrome Custom Tab), behind a handful of OS dialogs.
#
# Options (defaults in brackets):
#   VYSU_AUTH0_DOMAIN             [auth0.com]                     what an Auth0 url looks like
#   VYSU_AUTH0_SIGNIN_LABELS      [Se connecter,Sign in]          the door's button, web and mobile
#   VYSU_AUTH0_CONTINUE_LABELS    [Continuer,Continue]            Universal Login's submit
#   VYSU_AUTH0_DOOR_TEXT          [Se connecter]                  the mobile door screen's text
#   VYSU_AUTH0_HOME_TEXT          [Bienvenue]                     the text that proves the login
#   VYSU_AUTH0_PASSWORD_TEXT      [mot de passe]                  the password page's own text
#   VYSU_AUTH0_MENU_LABEL         [Menu]                          mobile: the side menu
#   VYSU_AUTH0_LOGOUT_LABEL       [Se déconnecter]                mobile: logging another persona out
#   VYSU_AUTH0_AFTER_LOGIN_LABELS [Entrer directement,Retour à l'accueil]   buttons pressed if they show up
# shellcheck shell=bash

auth0_opt() { cfg "AUTH0_$1" "$2"; }
auth0_domain() { auth0_opt DOMAIN auth0.com; }
# A comma-separated option as arguments: a label list is written the way a human reads it.
# shellcheck disable=SC2086  # splitting on the comma is the point: one label per line
auth0_labels() { local IFS=,; printf '%s\n' $1; }

# The centre of the first text field on screen, in points, for the surfaces the platform's
# accessibility cannot read: the picture is all there is to go by there.
auth0_first_field() { # platform → « x y »
  mob_fields "$1" | python3 -c '
import json, sys
boxes = json.load(sys.stdin)
if not boxes:
    raise SystemExit(1)
box = boxes[0]
print("%d %d" % (box["x"] + box["w"] // 2, box["y"] + box["h"] // 2))
'
}

auth_describe() {
  printf 'Auth0 Universal Login on *%s*, identifier-first (sign-in: %s)' \
    "$(auth0_domain)" "$(auth0_opt SIGNIN_LABELS 'Se connecter,Sign in')"
}

auth_web_login() { # persona url
  local persona="$1" url="$2"
  persona_require "$persona"
  local signin continue_labels
  signin="$(auth0_opt SIGNIN_LABELS 'Se connecter,Sign in')"
  continue_labels="$(auth0_opt CONTINUE_LABELS 'Continuer,Continue')"

  web "$persona" open "$url" >/dev/null
  step "open $url"
  # A door carries no form: its button starts the redirect. Other apps land on Auth0 directly.
  if ! web "$persona" get url | grep -q "$(auth0_domain)"; then
    web "$persona" wait 'button' >/dev/null
    # shellcheck disable=SC2046  # the label list is meant to become several arguments
    web_click_any "$persona" $(auth0_labels "$signin") \
      || die "login: no sign-in button on $url (VYSU_AUTH0_SIGNIN_LABELS)"
  fi
  web "$persona" wait --url "**$(auth0_domain)**" >/dev/null
  step "reach $(auth0_domain)"
  # Identifier-first Universal Login: e-mail, then password on a second page.
  web "$persona" wait 'input#username' >/dev/null
  web "$persona" fill 'input#username' "$PERSONA_EMAIL" >/dev/null
  # shellcheck disable=SC2046
  web_click_any "$persona" $(auth0_labels "$continue_labels") \
    || die "login: no continue button after the e-mail (VYSU_AUTH0_CONTINUE_LABELS)"
  step "fill the e-mail field"
  web "$persona" wait 'input#password' >/dev/null
  web "$persona" fill 'input#password' "$PERSONA_PASSWORD" >/dev/null
  # shellcheck disable=SC2046
  web_click_any "$persona" $(auth0_labels "$continue_labels") \
    || die "login: no continue button after the password (VYSU_AUTH0_CONTINUE_LABELS)"
  step "fill the password field"
  local origin; origin="$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')"
  web "$persona" wait --url "${origin}/**" >/dev/null
  web "$persona" wait 2500 >/dev/null
  step "land back on ${origin}"
  echo "logged in: $persona ($PERSONA_EMAIL) → $(web "$persona" get url | tail -1)"
}

auth_web_token() { # persona
  # auth0-spa-js keeps its cache in localStorage (cacheLocation="localstorage" in the app).
  web "$1" eval "(() => { for (const k of Object.keys(localStorage)) { if (!k.startsWith('@@auth0spajs@@') || k.endsWith('@@user@@')) continue; const t = JSON.parse(localStorage.getItem(k) || '{}'); if (t.body && t.body.access_token) return t.body.access_token; } return ''; })()" | tail -1 | tr -d '"'
}

auth_mobile_logout() { # platform — the keychain / keystore outlives a reinstall, so another
  # persona may still be signed in: side menu → logout.
  local platform="$1"
  mob_press_if "$platform" "$(auth0_opt MENU_LABEL Menu)" >/dev/null 2>&1 \
    && mob_press_if "$platform" "$(auth0_opt LOGOUT_LABEL 'Se déconnecter')" >/dev/null 2>&1
}

auth_mobile_login() { # platform persona
  local platform="$1" persona="$2"
  persona_require "$persona"
  local door home password_text after
  door="$(auth0_opt DOOR_TEXT 'Se connecter')"
  home="$(auth0_opt HOME_TEXT 'Bienvenue')"
  password_text="$(auth0_opt PASSWORD_TEXT 'mot de passe')"
  after="$(auth0_opt AFTER_LOGIN_LABELS 'Entrer directement,Retour à l'\''accueil')"
  local app; app="$(mobile_app "$platform")"
  [ -n "$app" ] || die "mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set"

  # Before the opens below, which drop stderr along with the « waiting for » line.
  [ "$platform" != ios ] || ios_lock
  [ "$platform" != android ] || { android_select; adb reverse tcp:8081 tcp:8081 >/dev/null 2>&1; }
  # The first open on a new simulator runtime builds agent-device's XCTest runner: give it room.
  mob "$platform" open "$app" --foreground --relaunch --timeout 600000 >/dev/null 2>&1 \
    || die "$platform: cannot open the dev-client (vysu up $platform --build?)"
  mobile_load_bundle "$platform"
  mob_press_any "$platform" "Autoriser,Allow" || true   # push permission, asked at first boot
  mob_press_any "$platform" "Close,Fermer" || true      # the dev menu, when it opens on top of the door
  mob_press_any "$platform" "Continue,Continuer" || true  # its first-launch intro on a fresh install
  if ! mob_wait_text "$platform" "$door" 8000; then
    auth_mobile_logout "$platform" || true
    mob_wait_text "$platform" "$door" 15000 || die "$platform: not on the door screen and no way to log out from here"
  fi
  mob_press_if "$platform" "$door" >/dev/null 2>&1 || mob "$platform" press "text=\"$door\"" --settle >/dev/null
  mob_press_any "$platform" "Continuer,Continue" || true   # iOS consent: « … wants to use auth0.com to sign in »
  # The Universal Login runs in a system web surface that agent-device reads through the platform's
  # accessibility. Identifier-first: e-mail, return, password, return.
  if [ "$platform" = android ]; then
    # Chrome's first run on a fresh AVD sits in front of the Custom Tab: terms, then the account prompt.
    mob_press_any android "Accepter et continuer,Accept & continue" || true
    mob_press_any android "Non merci,No thanks" || true
  fi
  # The field's label is the visible « e-mail » one on iOS, a bare "username" in the Custom Tab.
  if ! mob "$platform" wait 'role="textfield"' 20000 >/dev/null 2>&1 && ! mob "$platform" wait 'id="username"' 8000 >/dev/null 2>&1; then
    [ "$platform" = ios ] || die "$platform: the login form did not show up"
    # iOS 18 (the old iPhone): agent-device cannot read the SafariViewService sheet. The fields are
    # then read out of the picture (mob_fields → py/fields.py) rather than tapped at the constants
    # this used to carry (« 57 % and 65 % of the height »), which no longer hold as soon as Auth0
    # moves a logo. Identifier-first means one field at a time: the first box is the e-mail, and
    # after the submit the same probe, run again on the password page, gives the password.
    local point
    point="$(auth0_first_field ios)" || die "ios: no text field found on the sheet (py/fields.py saw none)"
    # shellcheck disable=SC2086  # « x y », two arguments on purpose
    mob ios press $point >/dev/null; sleep 1
    mob ios type "$PERSONA_EMAIL" >/dev/null; mob ios keyboard return >/dev/null; sleep 4
    point="$(auth0_first_field ios)" || die "ios: no password field found after the e-mail (py/fields.py saw none)"
    # shellcheck disable=SC2086
    mob ios press $point >/dev/null; sleep 1
    mob ios type "$PERSONA_PASSWORD" >/dev/null; mob ios keyboard return >/dev/null; sleep 6
    mob_press_any ios "Autoriser,Allow" || true
    mob_wait_text ios "$home" 30000 || true
    mob_press_all ios "$after" || true
    mstate_set ios persona "$persona"
    echo "ios: logged in as $persona ($PERSONA_EMAIL) — fields read from the capture (iOS 18 sheet not readable)"; return
  fi
  mob "$platform" fill 'role="textfield"' "$PERSONA_EMAIL" >/dev/null 2>&1 || mob "$platform" fill 'id="username"' "$PERSONA_EMAIL" >/dev/null
  mob "$platform" keyboard return >/dev/null 2>&1 || mob_press_any "$platform" "Continuer,Continue"
  mob "$platform" wait text "$password_text" 20000 >/dev/null
  mob "$platform" fill 'role="securetextfield"' "$PERSONA_PASSWORD" >/dev/null 2>&1 \
    || mob "$platform" fill 'id="password"' "$PERSONA_PASSWORD" >/dev/null 2>&1 \
    || mob "$platform" fill 'label="Mot de passe"' "$PERSONA_PASSWORD" >/dev/null
  mob "$platform" keyboard return >/dev/null 2>&1 || mob_press_any "$platform" "Continuer,Continue"
  sleep 3
  mob_press_any "$platform" "Plus tard,Not Now" || true    # Safari's « save this password? »
  mob_press_any "$platform" "Autoriser,Allow" || true      # push notification permission
  mob_wait_text "$platform" "$home" 30000 || true
  # The dev-launcher URL handed over at install is captured as a pending deep link and replayed
  # after login, which the router answers with a not-found screen: a dev-client artefact, not a
  # product bug. AFTER_LOGIN_LABELS is the way back out of it.
  mob_press_all "$platform" "$after" || true
  # One install is one session: which persona it holds is device state, and the next agent reads it
  # back from `vysu claim` rather than opening the side menu to find out.
  mstate_set "$platform" persona "$persona"
  echo "$platform: logged in as $persona ($PERSONA_EMAIL)"
}
