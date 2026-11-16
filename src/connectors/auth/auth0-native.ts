// A refresh token for the mobile app, minted without the app: Auth0's Universal Login walked over
// HTTP as the native client (authorization code + PKCE, a public client: no secret), which is what
// the app's own sign-in does through a browser sheet. 1.7 s on the Nidz tenant, against about 100 s
// to type the same two fields into the sheet on an emulator (5.1 h of one slice of the October
// sessions went to mobile logins).
import { createHash, randomBytes } from 'node:crypto';

export interface NativeGrant {
  issuer: string; // https://<tenant or custom domain>
  clientId: string;
  redirectUri: string; // the app's own, a custom scheme: never followed, only read
  audience: string;
  scope: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// Each step's failure names the step and what the server answered, never a credential nor a token.
class Step extends Error {}

const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export async function refreshTokenByPassword(g: NativeGrant, email: string, password: string, fetchImpl: Fetch = fetch): Promise<string> {
  const jar = new Map<string, string>();
  const hop = async (url: string, form?: Record<string, string>): Promise<Response> => {
    const headers: Record<string, string> = { 'user-agent': AGENT };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const r = await fetchImpl(url, { method: form ? 'POST' : 'GET', redirect: 'manual', headers, ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return r;
  };
  // Where a redirect leads, and a failure that says where it stopped instead.
  const next = (r: Response, step: string, want: string): URL => {
    const to = r.headers.get('location');
    if (r.status < 300 || r.status >= 400 || !to) throw new Step(`${step}: HTTP ${r.status}, no redirect (${want})`);
    return new URL(to, g.issuer);
  };

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(12).toString('base64url');
  const authorize = new URL('/authorize', g.issuer);
  const params: Record<string, string> = {
    client_id: g.clientId,
    redirect_uri: g.redirectUri,
    response_type: 'code',
    scope: g.scope,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    prompt: 'login',
  };
  if (g.audience) params.audience = g.audience;
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v);

  // Identifier-first: the e-mail page, then the password page, each a form posted back to its own url.
  let at = next(await hop(authorize.toString()), 'authorize', 'the login page');
  if (!at.pathname.includes('/login')) throw new Step(`authorize: led to ${at.pathname}, not to a login page (client id, redirect uri?)`);
  await hop(at.toString());
  at = next(
    await hop(at.toString(), { state: at.searchParams.get('state') ?? '', username: email, 'js-available': 'true', 'webauthn-available': 'true', 'is-brave': 'false', 'webauthn-platform-available': 'false', action: 'default' }),
    'e-mail page',
    'the address was refused, or the page asks for something else: a captcha?',
  );
  if (!at.pathname.includes('/password')) throw new Step(`e-mail page: led to ${at.pathname}, not to the password page`);
  await hop(at.toString());
  at = next(
    await hop(at.toString(), { state: at.searchParams.get('state') ?? '', username: email, password, action: 'default' }),
    'password page',
    'the password was refused, or the page asks for something else',
  );
  // /authorize/resume, then whatever the tenant puts before the app (a consent, an action's redirect).
  const scheme = new URL(g.redirectUri).protocol;
  for (let i = 0; i < 6 && at.protocol !== scheme; i++) {
    if (!/^https?:$/.test(at.protocol)) break;
    at = next(await hop(at.toString()), 'after the password', `the app's redirect ${scheme}// never came: a consent or an MFA page?`);
  }
  if (at.protocol !== scheme) throw new Step(`after the password: stopped on ${at.protocol}//${at.host}${at.pathname}, not on the app's redirect`);
  if (at.searchParams.get('state') !== state) throw new Step('the redirect came back with another state');
  const code = at.searchParams.get('code');
  if (!code) throw new Step(`the redirect carried no code (${at.searchParams.get('error') ?? 'no error named'})`);

  const r = await fetchImpl(new URL('/oauth/token', g.issuer).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: g.clientId, code_verifier: verifier, code, redirect_uri: g.redirectUri }),
  });
  const body = (await r.json().catch(() => ({}))) as { refresh_token?: unknown; error?: unknown };
  if (!r.ok) throw new Step(`token exchange: HTTP ${r.status} ${typeof body.error === 'string' ? body.error : ''}`.trim());
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new Step('token exchange: no refresh token (offline_access in the scope, refresh tokens allowed for the client?)');
  return body.refresh_token;
}
