# form — a plain same-origin login form: an e-mail, a password and a submit button, all on the page
# the login url opens. The fields are looked for by label first, then by placeholder, then by their
# input type; the button by role and name; and the login counts as done when the page has navigated
# away from the login url. A token is optional and the project says where it is, since a form app
# keeps it wherever it likes (a cookie no script can read, a store, a global).
#
# Options (defaults in brackets):
#   VYSU_FORM_EMAIL_LABELS    [E-mail,Email,Adresse e-mail,Identifiant,Username]
#   VYSU_FORM_PASSWORD_LABELS [Mot de passe,Password]
#   VYSU_FORM_SUBMIT_LABELS   [Se connecter,Connexion,Sign in,Log in,Login,Submit]
#   VYSU_FORM_TOKEN_JS        []   an expression evaluated in the page whose value is the token
#   VYSU_FORM_HOME_TEXT       []   mobile: the text(s) that prove the login, comma-separated;
#                                  falls back to VYSU_MOBILE_READY_TEXT, then to a fixed wait
#
# Mobile: the same, by accessibility label — the labels above are matched against what the platform
# announces, and the app is home when it shows one of VYSU_FORM_HOME_TEXT.
# shellcheck shell=bash

form_opt() { cfg "FORM_$1" "$2"; }
form_email_labels() { form_opt EMAIL_LABELS 'E-mail,Email,Adresse e-mail,Identifiant,Username'; }
form_password_labels() { form_opt PASSWORD_LABELS 'Mot de passe,Password'; }
form_submit_labels() { form_opt SUBMIT_LABELS 'Se connecter,Connexion,Sign in,Log in,Login,Submit'; }
# A comma-separated option, one label per line: a label is « Adresse e-mail », spaces and all, so
# the loops below read lines rather than split on whitespace. Setting IFS around the call instead
# would be a trap: bash 3.2 expands « "${@:2}" » — what the `web` and `mob` primitives pass on —
# joined by IFS, and every argument of the command would arrive as one.
# The labels are collected up front rather than read inside the loop that uses them: a here-string
# on the loop would be the primitives' stdin too, and agent-browser reads stdin.
FORM_LABELS=()
form_labels() { # "<label>,<label>…" → FORM_LABELS
  FORM_LABELS=()
  local label
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    FORM_LABELS+=("$label")
  done <<<"$(printf '%s' "$1" | tr ',' '\n')"
}

auth_describe() {
  local js; js="$(form_opt TOKEN_JS '')"
  printf 'a login form on the page itself (fields: %s / %s, submit: %s, token: %s)' \
    "$(form_email_labels)" "$(form_password_labels)" "$(form_submit_labels)" \
    "$( [ -n "$js" ] && echo 'VYSU_FORM_TOKEN_JS' || echo none )"
}

# A field by label, then by placeholder, then by input type: the three ways a form says what a box
# is for, in the order of how much the page meant it.
form_fill() { # persona "<label>,<label>…" <input type> <value>
  local persona="$1" labels="$2" type="$3" value="$4" label
  form_labels "$labels"; local list=(${FORM_LABELS[@]+"${FORM_LABELS[@]}"})
  for label in ${list[@]+"${list[@]}"}; do
    web "$persona" find label "$label" fill "$value" >/dev/null 2>&1 && return 0
    web "$persona" find placeholder "$label" fill "$value" >/dev/null 2>&1 && return 0
  done
  web "$persona" fill "input[type=$type]" "$value" >/dev/null 2>&1
}
# The submit button by role and name, then the form's own submit control: a button carrying an icon
# and no text has no accessible name to be found by.
form_submit() { # persona
  local persona="$1" label
  form_labels "$(form_submit_labels)"; local list=(${FORM_LABELS[@]+"${FORM_LABELS[@]}"})
  for label in ${list[@]+"${list[@]}"}; do
    web_click_any "$persona" "$label" && return 0
  done
  web "$persona" click 'button[type=submit], input[type=submit]' >/dev/null 2>&1
}
# Logged in = gone from the login url. A form that answers in place (an error under the field) never
# navigates, which is exactly the failure this has to name.
form_wait_away() { # persona <login url> [seconds] → prints where it landed
  local persona="$1" login="${2%/}" i here
  # shellcheck disable=SC2034  # the counter only bounds the loop
  for i in $(seq 1 "${3:-20}"); do
    here="$(web "$persona" get url 2>/dev/null | tail -1)"
    case "${here%/}" in
      # about:blank is the beat between the submit and the next document, not a destination.
      ''|about:blank|"$login") ;;
      *) printf '%s' "$here"; return 0;;
    esac
    sleep 1
  done
  return 1
}
# A field by accessibility label, then by role: a platform announces a form field by the label the
# app gave it, and by nothing at all when it gave none.
form_mob_fill() { # platform "<label>,<label>…" <role selector> <value>
  local platform="$1" labels="$2" role="$3" value="$4" label
  form_labels "$labels"; local list=(${FORM_LABELS[@]+"${FORM_LABELS[@]}"})
  for label in ${list[@]+"${list[@]}"}; do
    mob "$platform" fill "label=\"$label\"" "$value" >/dev/null 2>&1 && return 0
  done
  mob "$platform" fill "$role" "$value" >/dev/null 2>&1
}

auth_web_login() { # persona url
  local persona="$1" url="$2"
  persona_require "$persona"
  web "$persona" open "$url" >/dev/null
  step "open $url"
  form_fill "$persona" "$(form_email_labels)" email "$PERSONA_EMAIL" \
    || die "login: no e-mail field on $url (VYSU_FORM_EMAIL_LABELS)"
  step "fill the e-mail field"
  form_fill "$persona" "$(form_password_labels)" password "$PERSONA_PASSWORD" \
    || die "login: no password field on $url (VYSU_FORM_PASSWORD_LABELS)"
  step "fill the password field"
  form_submit "$persona" || die "login: no submit button on $url (VYSU_FORM_SUBMIT_LABELS)"
  step "submit"
  local here; here="$(form_wait_away "$persona" "$url")" \
    || die "login: still on $url after the submit — the credentials were refused, or the form answers in place"
  step "leave the login page"
  # The page the app lands on is the one the next capture is of, and the one a token is read from:
  # let it finish loading before saying the login is done.
  web "$persona" wait --load networkidle --timeout 5000 >/dev/null 2>&1 || true
  web "$persona" wait 500 >/dev/null
  echo "logged in: $persona ($PERSONA_EMAIL) → $here"
}

auth_web_token() { # persona
  local js; js="$(form_opt TOKEN_JS '')"
  [ -n "$js" ] || return 0
  web "$1" eval "$js" 2>/dev/null | tail -1 | tr -d '"'
}

auth_mobile_login() { # platform persona
  local platform="$1" persona="$2"
  persona_require "$persona"
  local app; app="$(mobile_app "$platform")"
  [ -n "$app" ] || die "mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set"
  [ "$platform" != ios ] || ios_lock
  [ "$platform" != android ] || { android_select; adb reverse "tcp:$(metro_port)" "tcp:$(metro_port)" >/dev/null 2>&1; }
  mob "$platform" open "$app" --foreground --relaunch --timeout 600000 >/dev/null 2>&1 \
    || die "$platform: cannot open the app (vysu up $platform --build?)"
  mobile_load_bundle "$platform"
  step "open $app"
  mob_press_any "$platform" "Autoriser,Allow" || true   # push permission, asked at first boot
  mob "$platform" wait 'role="textfield"' 20000 >/dev/null 2>&1 \
    || die "$platform: no text field on the login screen"
  form_mob_fill "$platform" "$(form_email_labels)" 'role="textfield"' "$PERSONA_EMAIL" \
    || die "$platform: no e-mail field (VYSU_FORM_EMAIL_LABELS)"
  step "fill the e-mail field"
  form_mob_fill "$platform" "$(form_password_labels)" 'role="securetextfield"' "$PERSONA_PASSWORD" \
    || die "$platform: no password field (VYSU_FORM_PASSWORD_LABELS)"
  step "fill the password field"
  mob_press_any "$platform" "$(form_submit_labels)" || mob "$platform" keyboard return >/dev/null
  step "submit"
  # Home is one of the screens the project named: the app under test is the only thing that knows
  # what the other side of its own login looks like.
  local ready; ready="$(form_opt HOME_TEXT "$(cfg MOBILE_READY_TEXT)")"
  if [ -n "$ready" ]; then
    local text seen=1
    form_labels "$ready"; local screens=(${FORM_LABELS[@]+"${FORM_LABELS[@]}"})
    for text in ${screens[@]+"${screens[@]}"}; do
      mob_wait_text "$platform" "$text" 20000 && { seen=0; break; }
    done
    [ "$seen" = 0 ] || die "$platform: none of VYSU_FORM_HOME_TEXT showed up after the submit"
    step "the app is home"
  else
    sleep 5
  fi
  # One install is one session: which persona it holds is device state, and the next agent reads it
  # back from `vysu claim` rather than opening the app to find out.
  mstate_set "$platform" persona "$persona"
  echo "$platform: logged in as $persona ($PERSONA_EMAIL)"
}

auth_mobile_logout() { : ; }
