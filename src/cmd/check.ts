// `vysu check <persona> [--save <name>]`: JS errors and failed API requests of the current session.
import { die } from '../core/errors.ts';
import { check } from '../web/page.ts';

export async function run(args: string[]): Promise<void> {
  const persona = args[0];
  if (!persona) die('usage: vysu check <persona> [--save <name>]');
  const save = args[1] === '--save' ? (args[2] ?? '') : '';
  process.stdout.write(await check(persona, save));
}
