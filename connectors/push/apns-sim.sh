# apns-sim — a simulated APNs push on the running iOS simulator. The preset file IS the APNs
# payload (aps.alert, mutable-content for a notification service extension, and whatever data
# fields the app's tap handler reads at the top level). No network, no certificate, no device token.
# shellcheck shell=bash

push_describe() { printf 'simulated APNs on the iOS simulator (simctl push), presets in .vysu/push/'; }

push_send() { # ios <preset> [k=v]…
  local platform="$1" preset="$2"; shift 2
  [ "$platform" = ios ] || die "apns-sim: the iOS simulator is the only target"
  local bundle; bundle="$(need_cfg MOBILE_BUNDLE "the app id to deliver to")"
  local json; json="$(push_payload "$preset" "$@")"
  # agent-device (like simctl) wants the payload as a file.
  local file="$STATE/push.apns"; mkdir -p "$STATE"; printf '%s' "$json" >"$file"
  ad ios push "$bundle" "$file" | tail -2
}
