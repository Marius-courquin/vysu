# Push drivers — the contract

A push driver is one bash file, sourced by the engine (never run), that answers two functions:

```bash
push_describe                 # one line for `vysu doctor`: where a push goes, and what is missing
push_send <target> <preset> [--platform ios|android] [k=v]…   # send it
```

`<target>` is the platform for a simulated push (`apns-sim`) and a persona name for a real one
(`fcm`, `webhook`). `<preset>` names a file the project owns, `.vysu/push/<preset>.json`: the engine
ships none, because only the app knows what its own payload looks like. `k=v` pairs are the
`--field` values of the command line, already parsed.

Which drivers exist is `VYSU_PUSH` in `.vysu/config`, comma-separated. `vysu push ios <preset>`
selects `apns-sim`; `vysu push <persona> <preset>` selects the first of `fcm` / `webhook` enabled.

## Presets

A preset is a JSON file with `{{field}}` placeholders. `push_payload <preset> "k=v"…` fills them —
from `--field` first, then from the persona's own variables — and dies naming the ones nothing
answered for, so a preset can carry an entity id without the caller repeating it. What the file
holds depends on the driver: an APNs payload for `apns-sim`, an FCM `message` body for `fcm`,
nothing at all for `webhook`, where the endpoint owns the payload and the preset is only a name.

```json
{ "notification": { "title": "A new ticket", "body": "{{title}}" },
  "data": { "ticketId": "{{ticketId}}" } }
```

```bash
vysu push alice ticket --field title="Lift out of order" --field ticketId=42
```

## The primitives

The same ones a connector may call — `cfg`, `die`, `log`, `persona_var`, `load_personas` — plus
`push_payload <preset> "k=v"…` and `ad ios|android <agent-device args…>` for a driver that talks to
a device. A driver never prints a token, a device id or a credential.

Options follow the connectors' convention: `VYSU_<DRIVER>_<KEY>`, read through `cfg`, documented in
the file's header with the default in brackets.

## The three drivers

- **`apns-sim`** — `simctl push` on the running iOS simulator. The preset **is** the APNs payload
  (`aps.alert`, `mutable-content` for a notification service extension, whatever data fields the
  app's tap handler reads). No network, no certificate, no device token: it proves the layout and
  the tap handling, not the delivery. Needs `VYSU_MOBILE_BUNDLE`.
- **`fcm`** — a real FCM HTTP v1 send. The service account JSON is `VYSU_FCM_SA` (absolute,
  `~`-relative, or relative to the state folder), the device token comes from the persona
  (`vysu persona set alice FCM_TOKEN_IOS <token>` / `FCM_TOKEN_ANDROID`), and the preset is the FCM
  `message` body — the driver adds `token` and nothing else. The OAuth assertion is an RS256 JWT
  signed with `openssl`; base64url and JSON are python3's standard library, so there is no package
  to install. Without `--platform`, every platform the persona holds a token for is sent to.
  `VYSU_FCM_ENDPOINT` replaces the real endpoint and exists for tests only.
- **`webhook`** — POST `{email, preset, platform, fields}` to `VYSU_PUSH_WEBHOOK_URL`, and print
  what the endpoint answers. The endpoint holds the credentials and the device tokens; vysu holds
  neither, which is what makes this the driver to reach for when the push service is behind a VPN
  or owned by another team.

## Writing one

Copy the shortest built-in (`apns-sim.sh`, sixteen lines) next to your project and name it in
`VYSU_PUSH`; a driver that lives in the project rather than in the engine is not supported yet —
open an issue if you need one, it is a two-line change in `push_load`.

## Testing one

There is no `vysu push test`: a push is observed on the device it lands on. Send one to a simulator
first (`vysu push ios <preset>`), then to a real device, and read the driver's own answer — `fcm`
prints the message name FCM gave it, `webhook` prints one line per device the endpoint tried. A
driver that cannot reach its device says which key is missing and how to set it, never a stack
trace.
