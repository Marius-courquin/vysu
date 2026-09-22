# Notifications (in-app, e-mail, push)

If a change touches a notification, it is **triggered for real** before the merge request. Three
channels, and `vysu doctor` says which of them this project wired up (`push: …`, the services, the
project commands).

| channel | how to trigger it | where to see it |
|---|---|---|
| **in-app** | produce the event through the real backend pipeline: the app itself, a `curl` with `vysu auth token <persona>`, or a project command (`.vysu/commands/<name>`, run as `vysu <name>`) | web and mobile, signed in as the persona who receives it |
| **e-mail** | the same, against an environment that actually sends mail (a local dev profile usually does not) | the mailbox of the persona's address |
| **push** | iOS simulator: `vysu push ios <preset>`. Real devices and Android emulators: `vysu push <persona> <preset> [--platform ios\|android] [--field k=v]…` | system banner, then the route opened on tap |

## Presets

A preset is a file the project owns, `.vysu/push/<preset>.json`; the engine ships none.
`{{field}}` placeholders are filled from `--field k=v` first, then from the persona's own variables
(`vysu persona set <name> <KEY> <value>`), so a preset can carry an entity id without the caller
repeating it. A placeholder left with no value fails the command and names the missing field.

## iOS: simulated APNs

An iOS simulator has no APNs token (a push SDK may still hand out a token, unusable). The
`apns-sim` driver therefore hands the payload to the simulator directly: `vysu push ios <preset>`
pushes what the backend would have produced. **The app must be in the background** (`vysu ios
home`) for a banner to appear. The preset is the APNs payload itself.

## Real sends

`vysu push <persona> <preset>` picks the first real-send driver enabled in `VYSU_PUSH`:

- **`fcm`** - a real FCM HTTP v1 send with a service account (`VYSU_FCM_SA`, a path under the state
  folder) to the token held by the persona (`VYSU_PERSONA_<NAME>_FCM_TOKEN_IOS` / `_ANDROID`). The
  preset holds the FCM message body. An Android emulator running a Google APIs image receives
  those.
- **`webhook`** - a POST of `{email, preset, platform, fields}` to `VYSU_PUSH_WEBHOOK_URL`, and the
  results the endpoint returns are printed. That is the route when an internal tool owns the
  sending.

`vysu doctor` prints one `push:` line per enabled driver, with what each one needs.

## Push from a local stack

When the project's backend service is the one sending, the service account and the feature flag are
its business, not the engine's: declare them in the service's `_ENV` (or in `vysu up api --env
k=v`) so `vysu up api` starts a backend that really sends, and copy a device registration row into
the local database so there is somewhere to send to.

## Diagnosis

A backend that logs "sending notification" and then nothing is nearly always a disabled feature
flag at startup, or a send failure swallowed downstream: read the service log
(`logs/<service>.log` under the state folder) from its startup line, not from the send.
