// `vysu ios|android <agent-device args…>`: the driver itself, on the chosen device, in its session,
// under its lock. It stays a CLI call: its output is agent-device's own, to the terminal as it is.
import type { Platform } from '../core/hold.ts';
import { ad } from './agent.ts';

export async function passthrough(p: Platform, args: string[]): Promise<number> {
  return (await ad(p, args, { inherit: true })).code;
}
