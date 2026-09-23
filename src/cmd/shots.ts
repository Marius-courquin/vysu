// `vysu shots <persona> <name> [--url <url>] [--sizes WxH,…] [--dark] [--full] [--no-expand]
// [--no-warm] [--freeze] [--lang <l>] [--ignore <css>]… [--baseline <name> | --baseline-url <url>]`.
import { die } from '../core/errors.ts';
import { shots, SHOTS_USAGE } from '../web/shots.ts';

export async function run(args: string[]): Promise<void> {
  const [persona, name] = args;
  if (!persona || !name) die(SHOTS_USAGE);
  await shots(persona, name, args.slice(2), (s) => process.stdout.write(s));
}
