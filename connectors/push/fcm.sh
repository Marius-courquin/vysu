# fcm — a real push through FCM HTTP v1, signed by a service account. The account's JSON file is
# named by VYSU_FCM_SA (absolute, `~`-relative, or relative to the state folder — it is a
# credential, and credentials live outside every repo); the device token comes from the persona
# (`VYSU_PERSONA_<NAME>_FCM_TOKEN_IOS` / `_ANDROID`, `vysu persona set alice FCM_TOKEN_IOS …`); and
# the preset file IS the FCM `message` body, with its `{{field}}` placeholders filled in and the
# token added. The OAuth assertion is an RS256 JWT signed with `openssl` — python3's standard
# library does the base64url and the JSON, and no pip package is needed for either.
#
# Options:
#   VYSU_FCM_SA        the service account JSON (required)
#   VYSU_FCM_SCOPE     [https://www.googleapis.com/auth/firebase.messaging]
#   VYSU_FCM_ENDPOINT  test only: where the send goes, instead of the real
#                      https://fcm.googleapis.com/v1/projects/<project>/messages:send
# shellcheck shell=bash

push_describe() {
  local sa; sa="$(cfg FCM_SA)"
  printf 'FCM HTTP v1 as %s' "${sa:-(VYSU_FCM_SA is not set)}"
}

fcm_sa_file() { # → the service account JSON, wherever the project keeps it
  local sa; sa="$(cfg FCM_SA)"
  [ -n "$sa" ] || die "fcm: VYSU_FCM_SA is not set (the service account JSON)"
  case "$sa" in
    '~'/*) sa="${sa/#\~/$HOME}";;
    /*) ;;
    *) sa="$STATE/$sa";;   # a credential belongs under the state folder, not in the repo
  esac
  [ -f "$sa" ] || die "fcm: no service account file $sa (VYSU_FCM_SA)"
  printf '%s' "$sa"
}
fcm_sa_field() { # file key
  SA_FILE="$1" python3 -c '
import json, os, sys
try:
    account = json.load(open(os.environ["SA_FILE"]))
except ValueError as error:
    sys.exit("vysu: fcm: %s is not JSON (%s)" % (os.environ["SA_FILE"], error))
value = account.get(sys.argv[1])
if not value:
    sys.exit("vysu: fcm: no « %s » in %s" % (sys.argv[1], os.environ["SA_FILE"]))
sys.stdout.write(value)
' "$2"
}
# The assertion Google exchanges for an access token: header and claims base64url-encoded, signed
# with the account's key. openssl reads the key from a file, so it is written out with nothing but
# the owner able to read it and removed on the way out — the shell never holds it in a variable.
fcm_jwt() { # sa-file client_email token_uri → the signed JWT
  local sa="$1" issuer="$2" audience="$3"
  local key="$STATE/.fcm-key-$$.pem" input="$STATE/.fcm-jwt-$$"
  mkdir -p "$STATE"
  ( umask 077; fcm_sa_field "$sa" private_key >"$key" )
  ( umask 077
    FCM_ISS="$issuer" FCM_AUD="$audience" FCM_SCOPE="$(cfg FCM_SCOPE https://www.googleapis.com/auth/firebase.messaging)" \
    python3 -c '
import base64, json, os, sys, time

def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=")

now = int(time.time())
header = {"alg": "RS256", "typ": "JWT"}
claims = {
    "iss": os.environ["FCM_ISS"],
    "scope": os.environ["FCM_SCOPE"],
    "aud": os.environ["FCM_AUD"],
    "iat": now,
    "exp": now + 3600,
}
parts = [json.dumps(part, separators=(",", ":")).encode() for part in (header, claims)]
sys.stdout.buffer.write(b".".join(b64(part) for part in parts))
' >"$input" )
  local signature
  signature="$(openssl dgst -sha256 -sign "$key" "$input" 2>/dev/null | python3 -c '
import base64, sys
sys.stdout.write(base64.urlsafe_b64encode(sys.stdin.buffer.read()).rstrip(b"=").decode())
')" || { rm -f "$key" "$input"; die "fcm: openssl could not sign with the account key"; }
  [ -n "$signature" ] || { rm -f "$key" "$input"; die "fcm: openssl signed nothing (is private_key a PEM?)"; }
  printf '%s.%s' "$(cat "$input")" "$signature"
  rm -f "$key" "$input"
}
fcm_access_token() { # sa-file → a bearer token, an hour's worth
  local sa="$1" issuer audience jwt out code
  issuer="$(fcm_sa_field "$sa" client_email)"
  audience="$(fcm_sa_field "$sa" token_uri)"
  jwt="$(fcm_jwt "$sa" "$issuer" "$audience")"
  out="$(curl -s -m 30 -w '\n%{http_code}' -X POST "$audience" \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
    --data-urlencode "assertion=$jwt")"
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  case "$code" in
    200) ;;
    000) die "fcm: $audience unreachable";;
    # The usual causes, in the order they happen: a key that is not the account's, and a Mac whose
    # clock drifted past the hour the assertion claims.
    400|401) die "fcm: $audience refused the assertion (HTTP $code) — wrong key, or a clock off by more than 5 min: $(printf '%s' "$out" | head -c 200)";;
    *) die "fcm: token exchange failed (HTTP $code): $(printf '%s' "$out" | head -c 200)";;
  esac
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    token = json.load(sys.stdin).get("access_token")
except ValueError:
    token = None
if not token:
    sys.exit("vysu: fcm: no access_token in the token response")
sys.stdout.write(token)
'
}

push_send() { # <persona> <preset> [--platform ios|android] [k=v]…
  local persona="$1" preset="$2"; shift 2
  local platform="" fields=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --platform) platform="$2"; shift 2;;
      *) fields+=("$1"); shift;;
    esac
  done
  local sa; sa="$(fcm_sa_file)"
  load_personas
  # One send per platform the persona holds a token for, unless --platform names one.
  local platforms="ios android"; [ -z "$platform" ] || platforms="$platform"
  local message token endpoint bearer="" sent=0 p
  message="$(push_payload "$preset" ${fields[@]+"${fields[@]}"})"
  for p in $platforms; do
    token="$(persona_var "$persona" "FCM_TOKEN_$(echo "$p" | tr '[:lower:]' '[:upper:]')")"
    if [ -z "$token" ]; then
      [ -z "$platform" ] || die "fcm: no $p device token for $persona (vysu persona set $persona FCM_TOKEN_$(echo "$p" | tr '[:lower:]' '[:upper:]') <token>)"
      continue
    fi
    # The token is only asked for once something is actually going to be sent.
    [ -n "$bearer" ] || bearer="$(fcm_access_token "$sa")"
    endpoint="$(cfg FCM_ENDPOINT)"
    [ -n "$endpoint" ] || endpoint="https://fcm.googleapis.com/v1/projects/$(fcm_sa_field "$sa" project_id)/messages:send"
    fcm_post "$endpoint" "$bearer" "$message" "$token" "$p" "$persona"
    sent=$((sent + 1))
  done
  [ "$sent" != 0 ] || die "fcm: $persona holds no device token (vysu persona set $persona FCM_TOKEN_IOS <token>)"
}

fcm_post() { # endpoint bearer message token platform persona
  local endpoint="$1" bearer="$2" message="$3" token="$4" platform="$5" persona="$6"
  # The preset is the `message` body, as the FCM v1 reference spells it; the device token is the
  # one field vysu owns, and it is added rather than asked of the project.
  local body
  body="$(FCM_MESSAGE="$message" FCM_TOKEN="$token" python3 -c '
import json, os, sys
try:
    message = json.loads(os.environ["FCM_MESSAGE"])
except ValueError as error:
    sys.exit("vysu: fcm: the preset is not JSON (%s)" % error)
message["token"] = os.environ["FCM_TOKEN"]
sys.stdout.write(json.dumps({"message": message}))
')"
  local out code
  out="$(curl -s -m 30 -w '\n%{http_code}' -X POST "$endpoint" \
    -H "Authorization: Bearer $bearer" -H 'Content-Type: application/json' -d "$body")"
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  case "$code" in
    200) echo "$platform: sent — $(printf '%s' "$out" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("name", "(no name)"))
except ValueError:
    print("(no answer)")
')";;
    000) die "fcm: $endpoint unreachable";;
    401|403) die "fcm: $endpoint refused the token (HTTP $code) — the account has no rights on this project";;
    404) echo "$platform: the device token is not registered any more (the app was reinstalled: vysu persona set $persona FCM_TOKEN_$(echo "$platform" | tr '[:lower:]' '[:upper:]') <token>)";;
    *) echo "$platform: HTTP $code — $(printf '%s' "$out" | head -c 300)";;
  esac
}
