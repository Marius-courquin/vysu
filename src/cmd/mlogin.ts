// `vysu mlogin ios|android <persona> [--force]`: log the persona in inside the app (one install = one
// session); a device that already holds it is left as it is, unless --force.
import { mlogin } from '../auth/commands.ts';
import { die } from '../core/errors.ts';

const USAGE = 'usage: vysu mlogin ios|android <persona> [--force]';

export async function run(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const rest = args.filter((a) => a !== '--force');
  const [platform, persona] = rest;
  if ((platform !== 'ios' && platform !== 'android') || !persona || rest.length > 2 || persona.startsWith('-')) die(USAGE);
  await mlogin(platform, persona, force);
}
