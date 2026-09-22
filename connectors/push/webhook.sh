# webhook — a real push, sent by an endpoint the project owns: vysu POSTs
# `{email, preset, platform, fields}` to VYSU_PUSH_WEBHOOK_URL and prints whatever the endpoint
# answers. The endpoint holds the credentials and the device tokens; vysu holds neither.
# shellcheck shell=bash

push_describe() {
  local url; url="$(cfg PUSH_WEBHOOK_URL)"
  printf 'POST to %s' "${url:-(VYSU_PUSH_WEBHOOK_URL is not set)}"
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
  local url; url="$(cfg PUSH_WEBHOOK_URL)"
  [ -n "$url" ] || die "webhook: VYSU_PUSH_WEBHOOK_URL is not set"
  load_personas
  local email; email="$(persona_var "$persona" EMAIL)"
  [ -n "$email" ] || die "persona '$persona' not in $PERSONAS"
  # The fields go over as an object, and a preset the project also keeps locally is not read here:
  # the endpoint owns the payload, vysu only names which one and with what.
  local json; json="$(python3 -c '
import json, sys
print(json.dumps(dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)))' ${fields[@]+"${fields[@]}"})"
  local body; body="$(printf '{"email":"%s","preset":"%s"%s,"fields":%s}' \
    "$email" "$preset" "${platform:+,\"platform\":\"$platform\"}" "$json")"
  local out code; out="$(curl -s -m 30 -w '\n%{http_code}' -X POST "$url" -H "Content-Type: application/json" -d "$body")"
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  case "$code" in
    200) printf '%s' "$out" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(sys.stdin.read() if False else 0)
results = d.get('results') if isinstance(d, dict) else None
if results is None:
    print(json.dumps(d, ensure_ascii=False)); raise SystemExit
for r in results:
    print(r.get('platform'), r.get('deviceModel'), 'OK' if r.get('ok') else 'FAILED', r.get('messageName') or r.get('error'))
";;
    404) echo "webhook: no ${platform:-} device registered for $email, or the endpoint does not serve $url";;
    000) die "webhook unreachable at $url (VPN up?)";;
    *) echo "webhook: HTTP $code — $(printf '%s' "$out" | head -c 200)";;
  esac
}
