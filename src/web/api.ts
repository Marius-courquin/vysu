// What the rest of the engine asks of the web code: a persona's browser session, what `vysu claim` /
// `release --reset` read and do on it, and the auth connector's own line. Owned by the web lot; the
// bodies below are placeholders until it lands, and their signatures are the contract the mobile and
// platform lots code to.
import type { RunResult } from '../core/proc.ts';

const notYet = (what: string): never => {
  throw new Error(`${what}: the web code is not ported yet`);
};

// agent-browser in the persona's session, locked and restored (`-` is an anonymous one).
export async function web(persona: string, args: string[]): Promise<RunResult> {
  return notYet(`web ${persona} ${args.join(' ')}`);
}
export async function webSessionExists(persona: string): Promise<boolean> {
  return notYet(`web session ${persona}`);
}
// The « state: … » line `vysu claim <persona>` prints.
export async function webClaimState(persona: string): Promise<string> {
  return notYet(`web claim state ${persona}`);
}
// `vysu release <persona> --reset`: back to light, 1440x900, the default language. The « reset: … » line.
export async function webReset(persona: string): Promise<string> {
  return notYet(`web reset ${persona}`);
}
// For `vysu doctor`: which connector, its options; the sessions this project has.
export async function authDescribeLine(): Promise<string> {
  return notYet('auth describe');
}
export async function webDoctorLines(): Promise<string[]> {
  return notYet('doctor web');
}
// The API access token of a persona's session (what `vysu auth token` prints), or ''.
export async function authToken(persona: string): Promise<string> {
  return notYet(`auth token ${persona}`);
}
