// token — no login page at all: the persona holds a token (`vysu persona add <name> --token`), and
// the connector puts it where the app looks for it at boot, then lets the app start on it. For an app
// whose door vysu must not or cannot walk through: a Google or Microsoft sign-in (which challenges
// automated browsers, and where an agent clicking an account chooser is a risk of its own), a
// passkey, a second factor, an SSO portal. Nothing is typed, nothing is clicked.
//
// The token is the persona's `TOKEN` key, read from personas.env (mode 600) and never printed. A JWT
// is read for its expiry before it is used: an expired one is refused with the command that replaces
// it, rather than turned into a session that captures the app's login page.
//
// Every slot of the persona (`alice@2`…) is handed the same token, each in its own browser. That is
// safe here and only here: a token with no refresh token behind it rotates nothing, so two sessions
// holding it cannot revoke each other (a login connector's slots each log in by themselves instead).
//
// Options (defaults in brackets):
//   VYSU_TOKEN_STORE     [localStorage:token]   where the app keeps it: localStorage:<key> or cookie:<name>
//   VYSU_TOKEN_WRITE_JS  []   instead of the store, statements run in the page with `token` in scope,
//                              for an app that keeps it in a shape of its own (a JSON object, a store)
//   VYSU_TOKEN_READ_JS   []   with it, an expression whose value is the token as the app holds it
//
// Mobile: none — a native app keeps its token where no browser reaches; log the app in with a
// connector that walks its door, or by hand.
import type { AuthConnector, AuthContext } from '../../auth/types.ts';

const opt = (v: AuthContext, key: string, def: string): string => v.cfg(`TOKEN_${key}`, def);

export interface Store {
  kind: 'localStorage' | 'cookie';
  name: string;
}

export function parseStore(spec: string): Store | string {
  const colon = spec.indexOf(':');
  const kind = colon < 0 ? spec : spec.slice(0, colon);
  const name = colon < 0 ? '' : spec.slice(colon + 1).trim();
  if ((kind !== 'localStorage' && kind !== 'cookie') || !name) {
    return `VYSU_TOKEN_STORE is localStorage:<key> or cookie:<name> (got « ${spec} »)`;
  }
  return { kind, name };
}

// A JWT's `exp`, in seconds since the epoch; 0 for a token that is not a JWT or carries none (an
// opaque token is used as it is: only the app can tell whether it still holds).
export function jwtExpiry(token: string): number {
  const parts = token.split('.');
  if (parts.length !== 3) return 0;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp : 0;
  } catch {
    return 0;
  }
}

// « expired 2 h ago » / « valid 40 min more »: what `auth test` and a login say about a JWT.
export function expiryWords(exp: number, now = Date.now() / 1000): string {
  const left = Math.round(exp - now);
  const span = (s: number): string => (s >= 5400 ? `${Math.round(s / 3600)} h` : s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`);
  return left <= 0 ? `expired ${span(-left)} ago` : `valid ${span(left)} more`;
}

const js = (s: string): string => JSON.stringify(s);

function writeJs(v: AuthContext, store: Store, token: string): string {
  const custom = opt(v, 'WRITE_JS', '');
  if (custom) return `(() => { const token = ${js(token)}; ${custom}; return 'set'; })()`;
  return `(() => { localStorage.setItem(${js(store.name)}, ${js(token)}); return 'set'; })()`;
}

function readJs(v: AuthContext, store: Store): string {
  return opt(v, 'READ_JS', '') || `localStorage.getItem(${js(store.name)}) || ''`;
}

function storeOf(v: AuthContext): Store {
  const s = parseStore(opt(v, 'STORE', 'localStorage:token'));
  if (typeof s === 'string') v.die(s);
  return s;
}

// The cookie as the session holds it, for the page's origin: `cookies get` answers every cookie of
// the context, JSON with --json.
async function cookieValue(v: AuthContext, persona: string, name: string): Promise<string> {
  const r = await v.webTry(persona, 'cookies', 'get', '--json');
  try {
    const d = JSON.parse(v.lastLine(r.stdout)) as { data?: { cookies?: Array<{ name?: string; value?: string }> } };
    return d.data?.cookies?.find((c) => c.name === name)?.value ?? '';
  } catch {
    return '';
  }
}

export const connector: AuthConnector = {
  describe(v) {
    const custom = opt(v, 'WRITE_JS', '');
    return `a token the persona holds (vysu persona add <name> --token), put ${custom ? 'by VYSU_TOKEN_WRITE_JS' : `in ${opt(v, 'STORE', 'localStorage:token')}`}: no login page is opened`;
  },

  async webLogin(v, persona, url) {
    const token = v.personaVar(persona, 'TOKEN');
    const base = persona.split('@')[0]!;
    if (!token) v.die(`persona '${base}' holds no token`, `vysu persona set ${base} TOKEN   (asked for, not echoed; a pipe answers too)`);
    const exp = jwtExpiry(token);
    if (exp && exp <= Date.now() / 1000) {
      v.die(`the token of '${base}' ${expiryWords(exp)}: a new one is needed`, `vysu persona set ${base} TOKEN`);
    }
    const store = storeOf(v);
    const origin = new URL(url).origin;
    if (store.kind === 'cookie' && !opt(v, 'WRITE_JS', '')) {
      // Before the page loads, so its very first request already carries it.
      await v.web(persona, 'cookies', 'set', store.name, token, '--url', origin);
      v.step(`cookie ${store.name} set on ${origin}`);
      await v.web(persona, 'open', url);
    } else {
      // localStorage belongs to a document of the origin: open one, write, then start the app again so
      // that it boots on the token rather than on the empty store it read a moment ago.
      await v.web(persona, 'open', url);
      if (!(await v.web(persona, 'eval', writeJs(v, store, token))).includes('set')) v.die(`could not write the token into ${url}`);
      v.step(`token written (${opt(v, 'WRITE_JS', '') ? 'VYSU_TOKEN_WRITE_JS' : `localStorage ${store.name}`})`);
      await v.web(persona, 'open', url);
    }
    v.step(`open ${url}`);
    await v.webTry(persona, 'wait', '--load', 'networkidle', '--timeout', '5000');
    await v.web(persona, 'wait', '500');
    // An app that refuses a token usually drops it on boot: still there is the one proof a page gives
    // without knowing the app.
    const held = await connector.webToken(v, persona);
    if (!held) v.die(`the app dropped the token of '${base}' on boot: refused, or kept elsewhere (VYSU_TOKEN_STORE, VYSU_TOKEN_READ_JS)`, `vysu persona set ${base} TOKEN`);
    v.step('the app kept the token');
    const here = v.lastLine((await v.webTry(persona, 'get', 'url')).stdout);
    const email = v.personaVar(persona, 'EMAIL');
    console.log(`logged in: ${persona}${email ? ` (${email})` : ''} by token${exp ? `, ${expiryWords(exp)}` : ''} → ${here || url}`);
  },

  async webToken(v, persona) {
    const store = storeOf(v);
    if (store.kind === 'cookie' && !opt(v, 'READ_JS', '')) return (await cookieValue(v, persona, store.name)) || undefined;
    const r = await v.webTry(persona, 'eval', readJs(v, store));
    return r.code === 0 ? v.value(r.stdout) || undefined : undefined;
  },

  async mobileLogin(v, platform) {
    v.die(`${platform}: the token connector is web only — a native app keeps its token where no browser reaches (log the app in by hand, or with a connector that walks its door)`);
  },

  mobileLogout: async () => true,
};
