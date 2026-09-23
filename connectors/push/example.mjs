// example — the template a project copies to `.vysu/push-drivers/<name>.mjs` and names in VYSU_PUSH.
// A push driver answers two functions, each given the primitives as its first argument (`v`); it runs
// wherever vysu runs, Windows included (`.vysu/push-drivers/<name>.sh`, the bash form, needs a bash).
// `.js` and `.ts` work the same. A project driver named like a built-in (`fcm`, `webhook`,
// `apns-sim`) replaces it.
//
//   cp "$VYSU_ENGINE/connectors/push/example.mjs" .vysu/push-drivers/mine.mjs
//
// Options: a driver reads its own through `v.cfg('<DRIVER>_<KEY>', '<default>')`, which is the config
// key VYSU_<DRIVER>_<KEY>. Document them here, with their defaults in brackets:
//   VYSU_MINE_URL   [(none)]   where the send goes
//
// The primitives: v.cfg / v.need, v.payload(preset, fields) (the preset with its {{field}}s filled),
// v.personaVar(persona, KEY), v.mob(platform, args) (agent-device on the device, under its lock),
// v.say / v.log / v.die, v.state (the state folder), v.personas (the personas file).
// A driver never prints a token, a device id or a credential.

export function describe(v) {
  return `POST to ${v.cfg('MINE_URL') || '(VYSU_MINE_URL is not set)'}`;
}

// `vysu push <persona> <preset> [--platform ios|android] [--field k=v]…` (target: the persona), or
// `vysu push ios <preset>` for a driver that replaces apns-sim (target: ios).
export async function send(v, { target, preset, platform, fields }) {
  const url = v.cfg('MINE_URL');
  if (!url) v.die('mine: VYSU_MINE_URL is not set');
  const token = v.personaVar(target, `PUSH_TOKEN_${(platform || 'ios').toUpperCase()}`);
  if (!token) v.die(`mine: no device token for ${target} (vysu persona set ${target} PUSH_TOKEN_IOS <token>)`);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, message: JSON.parse(v.payload(preset, fields)) }),
    signal: AbortSignal.timeout(30000),
  });
  v.say(`${platform || 'ios'}: HTTP ${r.status}`);
}
