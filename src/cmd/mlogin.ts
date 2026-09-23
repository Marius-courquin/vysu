// `vysu mlogin ios|android <persona>`: log the persona in inside the app (one install = one session).
import { mlogin } from '../auth/commands.ts';
import { die } from '../core/errors.ts';

export async function run(args: string[]): Promise<void> {
  const [platform, persona] = args;
  if (!platform || !persona) die('usage: vysu mlogin ios|android <persona>');
  await mlogin(platform, persona);
}
