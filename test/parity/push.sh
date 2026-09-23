#!/usr/bin/env bash
# Parity of the push drivers: both engines send the presets of a scratch project to fake FCM and
# webhook endpoints (test/parity/push/server.mjs), their output, exit code and the requests the
# endpoints received compared. No device, no network beyond 127.0.0.1, nothing outside the scratch dir.
#
#   test/parity/push.sh <scratch dir>
set -uo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
W="${1:?usage: test/parity/push.sh <scratch dir>}"
mkdir -p "$W"
W="$(cd "$W" && pwd -P)/push-$$"
P="$W/proj"
mkdir -p "$P/.vysu/push" "$W/state"

# The account's key, the personas, the presets and the config the cases run against.
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
writeFileSync(process.argv[1], JSON.stringify({ type: "service_account", project_id: "demo-proj", client_email: "sa@demo-proj.iam.gserviceaccount.com", token_uri: "http://127.0.0.1:18089/token", private_key: key }));
' "$W/sa.json"
cat >"$W/state/personas.env" <<'P'
VYSU_PERSONA_ALICE_EMAIL='alice@example.com'
VYSU_PERSONA_ALICE_PASSWORD='x'
VYSU_PERSONA_ALICE_FCM_TOKEN_IOS='tok-ios'
VYSU_PERSONA_ALICE_FCM_TOKEN_ANDROID='tok-and'
VYSU_PERSONA_BOB_EMAIL='bob@example.com'
VYSU_PERSONA_BOB_PASSWORD='y'
P
cat >"$P/.vysu/push/ticket.json" <<'P'
{ "aps": { "alert": { "title": "Signalement : Ascenseur bloqué au 1er", "body": "Votre gestionnaire a pris en compte votre incident" }, "mutable-content": 1 }, "entityId": "00000000-0000-0000-0000-000000000000" }
P
cat >"$P/.vysu/push/withfield.json" <<'P'
{ "notification": { "title": "{{title}}", "body": "{{ body }}" }, "data": { "ticketId": "{{ticketId}}" } }
P
cat >"$P/.vysu/config" <<C
VYSU_PROJECT='pushtest'
VYSU_STATE='$W/state'
VYSU_PUSH='fcm'
VYSU_FCM_SA='$W/sa.json'
VYSU_FCM_ENDPOINT='http://127.0.0.1:18089/send'
VYSU_PUSH_WEBHOOK_URL='http://127.0.0.1:18089/hook'
VYSU_MOBILE_BUNDLE='fr.example.app'
C

node "$ENGINE/test/parity/push/server.mjs" "$W/requests.log" &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 0.5
cd "$P" || exit 2
n=0 FAILED=0 PASSED=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue;; esac
  n=$((n + 1))
  for side in legacy ts; do
    : >"$W/requests.log"
    eval "set -- $line"
    pre=()
    if [ "$1" = env ]; then shift; while [[ "$1" == *=* ]]; do pre+=("$1"); shift; done; fi
    bin=("$ENGINE/bin/vysu"); [ "$side" = legacy ] && bin=(bash "$ENGINE/legacy/vysu")
    env ${pre[@]+"${pre[@]}"} "${bin[@]}" "$@" >"$W/$n.$side" 2>&1 </dev/null
    echo "exit $?" >>"$W/$n.$side"
    # The assertion carries its own time: the rest of a request is compared as it was sent.
    sed -E 's/assertion=[^ &]*/assertion=<jwt>/' "$W/requests.log" >"$W/$n.$side.req"
  done
  if diff -q "$W/$n.legacy" "$W/$n.ts" >/dev/null && diff -q "$W/$n.legacy.req" "$W/$n.ts.req" >/dev/null; then
    PASSED=$((PASSED + 1)); echo "same  $line"
  else
    FAILED=$((FAILED + 1)); echo "DIFF  $line"
    diff "$W/$n.legacy" "$W/$n.ts" | sed 's/^/      /'
    diff "$W/$n.legacy.req" "$W/$n.ts.req" | sed 's/^/      /' | cut -c1-240
  fi
done <"$ENGINE/test/parity/push/cases.txt"
echo "push parity: $PASSED same, $FAILED different ($W)"
[ "$FAILED" = 0 ]
