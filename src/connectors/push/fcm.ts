// fcm — a real push through FCM HTTP v1, signed by a service account. The account's JSON file is named
// by VYSU_FCM_SA (absolute, `~`-relative, or relative to the state folder — it is a credential, and
// credentials live outside every repo); the device token comes from the persona
// (`VYSU_PERSONA_<NAME>_FCM_TOKEN_IOS` / `_ANDROID`, `vysu persona set alice FCM_TOKEN_IOS …`); and the
// preset file IS the FCM `message` body, with its `{{field}}` placeholders filled in and the token
// added. The OAuth assertion is an RS256 JWT signed with node:crypto: no openssl, no package.
//
// Options:
//   VYSU_FCM_SA        the service account JSON (required)
//   VYSU_FCM_SCOPE     [https://www.googleapis.com/auth/firebase.messaging]
//   VYSU_FCM_ENDPOINT  test only: where the send goes, instead of the real
//                      https://fcm.googleapis.com/v1/projects/<project>/messages:send
import { createSign } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { PushContext, PushDriver } from '../../push/push.ts';
import { fetchFailure, shownUrl, withoutCredentials } from '../../push/http.ts';
import { pyJson } from '../../push/pyjson.ts';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const head = (s: string, n: number): string => Buffer.from(s, 'utf8').subarray(0, n).toString('utf8');
const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

// The service account JSON, wherever the project keeps it.
function saFile(v: PushContext): string {
  let sa = v.cfg('FCM_SA');
  if (!sa) v.die('fcm: VYSU_FCM_SA is not set (the service account JSON)');
  if (sa.startsWith('~/')) sa = join(homedir(), sa.slice(2));
  else if (!isAbsolute(sa)) sa = join(v.state, sa); // a credential belongs under the state folder, not in the repo
  let ok = false;
  try {
    ok = statSync(sa).isFile();
  } catch {
    ok = false;
  }
  if (!ok) v.die(`fcm: no service account file ${sa} (VYSU_FCM_SA)`);
  return sa;
}
function saField(v: PushContext, file: string, key: string): string {
  let account: Record<string, unknown>;
  try {
    account = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    v.die(`fcm: ${file} is not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const value = account[key];
  if (!value || typeof value !== 'string') v.die(`fcm: no « ${key} » in ${file}`);
  return value;
}

// The assertion Google exchanges for an access token: header and claims base64url-encoded, signed
// with the account's key. The key never leaves this process: no file written, no tool handed it.
export function fcmJwt(key: string, issuer: string, audience: string, scope: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: issuer, scope, aud: audience, iat: nowSeconds, exp: nowSeconds + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${signer.sign(key).toString('base64url')}`;
}

async function accessToken(v: PushContext, sa: string): Promise<string> {
  const issuer = saField(v, sa, 'client_email');
  const audience = saField(v, sa, 'token_uri');
  const key = saField(v, sa, 'private_key');
  let jwt: string;
  try {
    jwt = fcmJwt(key, issuer, audience, v.cfg('FCM_SCOPE', SCOPE));
  } catch {
    v.die('fcm: could not sign with the account key (is private_key a PEM?)');
  }
  let code = 0;
  let out = '';
  let why = '';
  const target = withoutCredentials(audience, { 'Content-Type': 'application/x-www-form-urlencoded' });
  try {
    const r = await fetch(target.url, {
      method: 'POST',
      headers: target.headers,
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
      signal: AbortSignal.timeout(30000),
    });
    code = r.status;
    out = await r.text();
  } catch (e) {
    code = 0;
    why = fetchFailure(e);
  }
  const shown = shownUrl(audience);
  if (code === 0) v.die(`fcm: ${shown} unreachable: ${why}`);
  // The usual causes, in the order they happen: a key that is not the account's, and a machine whose
  // clock drifted past the hour the assertion claims.
  if (code === 400 || code === 401) v.die(`fcm: ${shown} refused the assertion (HTTP ${code}) — wrong key, or a clock off by more than 5 min: ${head(out, 200)}`);
  if (code !== 200) v.die(`fcm: token exchange failed (HTTP ${code}): ${head(out, 200)}`);
  let token: unknown;
  try {
    token = (JSON.parse(out) as { access_token?: unknown }).access_token;
  } catch {
    token = undefined;
  }
  if (!token || typeof token !== 'string') v.die('fcm: no access_token in the token response');
  return token;
}

async function post(v: PushContext, endpoint: string, bearer: string, message: string, token: string, platform: string, persona: string): Promise<void> {
  // The preset is the `message` body, as the FCM v1 reference spells it; the device token is the one
  // field vysu owns, and it is added rather than asked of the project.
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(message) as Record<string, unknown>;
  } catch (e) {
    v.die(`fcm: the preset is not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  m.token = token;
  let code = 0;
  let out = '';
  let why = '';
  // The bearer is the authorization here: credentials in a test endpoint's url are only taken out of it.
  const target = withoutCredentials(endpoint, { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' });
  try {
    const r = await fetch(target.url, {
      method: 'POST',
      headers: target.headers,
      body: pyJson({ message: m }),
      signal: AbortSignal.timeout(30000),
    });
    code = r.status;
    out = await r.text();
  } catch (e) {
    code = 0;
    why = fetchFailure(e);
  }
  const shown = shownUrl(endpoint);
  const upper = platform.toUpperCase();
  if (code === 200) {
    let name = '(no answer)';
    try {
      const n = (JSON.parse(out) as { name?: unknown }).name;
      name = n === undefined ? '(no name)' : String(n);
    } catch {
      name = '(no answer)';
    }
    v.say(`${platform}: sent — ${name}`);
  } else if (code === 0) v.die(`fcm: ${shown} unreachable: ${why}`);
  else if (code === 401 || code === 403) v.die(`fcm: ${shown} refused the token (HTTP ${code}) — the account has no rights on this project`);
  else if (code === 404) v.say(`${platform}: the device token is not registered any more (the app was reinstalled: vysu persona set ${persona} FCM_TOKEN_${upper} <token>)`);
  else v.say(`${platform}: HTTP ${code} — ${head(out, 300)}`);
}

export const driver: PushDriver = {
  describe: (v) => `FCM HTTP v1 as ${v.cfg('FCM_SA') || '(VYSU_FCM_SA is not set)'}`,
  async send(v, s) {
    const sa = saFile(v);
    if (!existsSync(v.personas)) v.die(`no ${v.personas} (vysu persona add <name>)`);
    // One send per platform the persona holds a token for, unless --platform names one.
    const platforms = s.platform ? [s.platform] : ['ios', 'android'];
    const message = v.payload(s.preset, s.fields);
    let bearer = '';
    let sent = 0;
    for (const p of platforms) {
      const token = v.personaVar(s.target, `FCM_TOKEN_${p.toUpperCase()}`);
      if (!token) {
        if (s.platform) v.die(`fcm: no ${p} device token for ${s.target} (vysu persona set ${s.target} FCM_TOKEN_${p.toUpperCase()} <token>)`);
        continue;
      }
      // The token is only asked for once something is actually going to be sent.
      bearer ||= await accessToken(v, sa);
      const endpoint = v.cfg('FCM_ENDPOINT') || `https://fcm.googleapis.com/v1/projects/${saField(v, sa, 'project_id')}/messages:send`;
      await post(v, endpoint, bearer, message, token, p, s.target);
      sent++;
    }
    if (!sent) v.die(`fcm: ${s.target} holds no device token (vysu persona set ${s.target} FCM_TOKEN_IOS <token>)`);
  },
};
