# Push drivers — the contract

A push driver sends one notification for one kind of delivery and answers two functions: one line
for `vysu doctor`, and the send itself.

It comes in two forms, with the same functions and the same primitives:

- **a module** — `.vysu/push-drivers/<name>.mjs` (or `.js`, `.ts`) exporting the functions, each
  given the primitives as its first argument. It runs wherever vysu runs, Windows included. The
  built-ins (`apns-sim`, `fcm`, `webhook`) are written this way, in `src/connectors/push/`; the
  template is `connectors/push/example.mjs`.
- **a bash file** — `.vysu/push-drivers/<name>.sh`, the form every project wrote for the bash engine,
  kept working on macOS and Linux: vysu sources it in a bash under `set -euo pipefail`, with the
  functions it calls defined around it (`src/push/prelude.sh`). The files beside this README
  (`apns-sim.sh`, `fcm.sh`, `webhook.sh`) are the bash engine's own drivers, and the shape to copy.

```js
// .vysu/push-drivers/<name>.mjs
export function describe(v)                                     // one line: where a push goes, what is missing
export async function send(v, { target, preset, platform, fields })   // send it
```

```bash
# .vysu/push-drivers/<name>.sh
push_describe                                              # printf the line
push_send <target> <preset> [--platform ios|android] [k=v]…   # send it
```

`target` is the platform for a simulated push (`apns-sim`) and a persona name for a real one (`fcm`,
`webhook`). `preset` names a file the project owns, `.vysu/push/<preset>.json`: the engine ships
none, because only the app knows what its own payload looks like. `fields` are the `--field` values
of the command line, as `k=v` strings; `platform` is `--platform`, or empty.

Which drivers exist is `VYSU_PUSH` in `.vysu/config`, comma-separated. `vysu push ios <preset>`
selects `apns-sim`; `vysu push <persona> <preset>` selects the first enabled driver that can reach a
device: `fcm`, `webhook`, or a project driver of any other name. A project driver named like a
built-in replaces it.

## Presets

A preset is a JSON file with `{{field}}` placeholders. The payload primitive fills them from
`--field` and stops on the ones nothing answered for, naming them (`vysu push: no value for body,
ticketId (--field body=…)`). What the file holds depends on the driver: an APNs payload for
`apns-sim`, an FCM `message` body for `fcm`, nothing at all for `webhook`, where the endpoint owns the
payload and the preset is only a name.

```json
{ "notification": { "title": "A new ticket", "body": "{{title}}" },
  "data": { "ticketId": "{{ticketId}}" } }
```

```bash
vysu push alice ticket --field title="Lift out of order" --field ticketId=42
```

## The primitives

| module (`v.`) | bash | what it does |
|---|---|---|
| `cfg(KEY, default)` · `need(KEY, why)` | `cfg` · `need_cfg` | a config value (`VYSU_<KEY>`), or die naming the key |
| `payload(preset, fields)` | `push_payload <preset> k=v…` | the preset with its placeholders filled |
| `personaVar(persona, KEY)` | `load_personas`, then `persona_var <persona> <KEY>` | a persona's own value (`FCM_TOKEN_IOS`, `EMAIL`) |
| `mob(platform, args)` | `ad` / `mob <platform> <agent-device args…>` | agent-device on the chosen device, under its lock |
| `say(line)` · `log(msg)` · `die(msg, next)` | `echo` · `log` · `die` | a line of the answer, a note on stderr, the end of the command |
| `state` · `personas` | `$STATE` · `$PERSONAS` | the state folder, the personas file |

A driver never prints a token, a device id or a credential. Options follow the connectors'
convention: `VYSU_<DRIVER>_<KEY>`, read through `cfg`, documented in the file's header with the
default in brackets.

## The three drivers

- **`apns-sim`** — `simctl push`, through agent-device, on the running iOS simulator. The preset
  **is** the APNs payload (`aps.alert`, `mutable-content` for a notification service extension,
  whatever data fields the app's tap handler reads). No network, no certificate, no device token: it
  proves the layout and the tap handling, not the delivery. Needs `VYSU_MOBILE_BUNDLE`.
- **`fcm`** — a real FCM HTTP v1 send. The service account JSON is `VYSU_FCM_SA` (absolute,
  `~`-relative, or relative to the state folder), the device token comes from the persona
  (`vysu persona set alice FCM_TOKEN_IOS <token>` / `FCM_TOKEN_ANDROID`), and the preset is the FCM
  `message` body — the driver adds `token` and nothing else. The OAuth assertion is an RS256 JWT
  signed with `node:crypto`, the key never written anywhere: no openssl, no package. Without
  `--platform`, every platform the persona holds a token for is sent to. `VYSU_FCM_ENDPOINT` replaces
  the real endpoint and exists for tests only.
- **`webhook`** — POST `{email, preset, platform, fields}` to `VYSU_PUSH_WEBHOOK_URL`, and print what
  the endpoint answers. The endpoint holds the credentials and the device tokens; vysu holds neither,
  which is what makes this the driver to reach for when the push service is behind a VPN or owned by
  another team.

## Writing one

Copy `connectors/push/example.mjs` to `.vysu/push-drivers/<name>.mjs` in your project and name it in
`VYSU_PUSH`. A bash driver from the bash engine keeps working as it is on macOS and Linux; on Windows,
rewrite it as a module (vysu says so when it meets one without a bash).

## Testing one

There is no `vysu push test`: a push is observed on the device it lands on. Send one to a simulator
first (`vysu push ios <preset>`), then to a real device, and read the driver's own answer — `fcm`
prints the message name FCM gave it, `webhook` prints one line per device the endpoint tried. A
driver that cannot reach its device says which key is missing and how to set it, never a stack
trace. `vysu doctor` prints each enabled driver's `describe` line.
