// `vysu <persona> <agent-browser args…>`: agent-browser as it is, in the persona's session (state
// restored, lock taken), its output straight through. `-` is an anonymous session.
import { ab } from './ab.ts';

export async function passthrough(persona: string, args: string[]): Promise<number> {
  return (await ab(persona, args, { inherit: true })).code;
}
