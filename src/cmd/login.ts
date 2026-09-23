// `vysu login <persona> [url]`: log the persona in through the project's auth connector (at
// VYSU_ORIGIN + VYSU_LOGIN_PATH when no url is given).
import { login } from '../auth/commands.ts';
import { die } from '../core/errors.ts';

export async function run(args: string[]): Promise<void> {
  const persona = args[0];
  if (!persona) die('usage: vysu login <persona> [url]');
  await login(persona, args[1] ?? '');
}
