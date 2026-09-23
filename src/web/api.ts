// What the rest of the engine asks of the web code: a persona's browser session, what `vysu claim` /
// `release --reset` read and do on it, and the auth connector's own line. The mobile code and the
// platform commands call these signatures.
import { config } from '../core/ctx.ts';
import type { RunResult } from '../core/proc.ts';
import { ab, abRaw, bboxes, bcmd, brun, browserName as name, evalValue, lastResult, sessionRunning } from './ab.ts';
import { langReadJs } from './js.ts';
import { setLang } from './page.ts';

// agent-browser in the persona's session, locked and restored (`-` is an anonymous one). Its stderr
// comes back in the result, the restore chatter filtered out.
export async function web(persona: string, args: string[]): Promise<RunResult> {
  return ab(persona, args, { stderr: 'capture' });
}
export async function webSessionExists(persona: string): Promise<boolean> {
  return sessionRunning(persona);
}
// The « state: … » line `vysu claim <persona>` prints. A web session carries its own login and its
// own URL: there is nothing vysu has to remember for it, so the state is read from the browser
// rather than from a file.
export async function webClaimState(persona: string): Promise<string> {
  if (!(await sessionRunning(persona))) return `state: (no session — vysu login ${persona})`;
  const r = await ab(persona, ['eval', `location.href${langReadJs(' + " · lang " + ')}`], { stderr: 'drop' });
  return `state: url ${evalValue(r.stdout)}`;
}
// `vysu release <persona> --reset`: back to light, 1440x900, the default language. The « reset: … » line.
export async function webReset(persona: string): Promise<string> {
  if (!(await sessionRunning(persona))) return `reset: no ${persona} session`;
  bcmd('set', 'media', 'light');
  bcmd('set', 'viewport', '1440', '900');
  const def = config().get('LANG');
  if (!config().get('LANG_STORAGE_KEY') || !def) {
    bboxes(await brun(persona));
    return `reset: ${persona} → media light, viewport 1440x900`;
  }
  bcmd('eval', langReadJs());
  const lang = lastResult(await brun(persona));
  let did = '';
  if (lang && lang !== def) {
    await setLang(persona, def);
    did = `, lang ${def}`;
  }
  return `reset: ${persona} → media light, viewport 1440x900${did}`;
}
// For `vysu doctor`: which connector, its options; the sessions this machine's agent-browser runs.
export async function authDescribeLine(): Promise<string> {
  return (await import('../auth/load.ts')).authDescribeLine();
}
export async function webDoctorLines(): Promise<string[]> {
  const r = await abRaw(['session', 'list'], { stderr: 'drop' });
  return r.stdout
    .split('\n')
    .filter((l, i, all) => l !== '' || i < all.length - 1)
    .map((l) => `session: ${l}`);
}
// The API access token of a persona's session (what `vysu auth token` prints), or ''.
export async function authToken(persona: string): Promise<string> {
  return (await (await import('../auth/commands.ts')).token(persona)) ?? '';
}
// For `vysu doctor`: which browser a capture renders in — the engine's headless
// Chrome for Testing, or the one this machine chose (a diff against a baseline captured elsewhere
// depends on it).
export function browserName(): string {
  return name();
}
