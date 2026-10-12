// `vysu walk <persona> <name> --url <url> [shots options…]`: the one call behind « check this
// screen »: open it, collect what the browser complained about, capture every viewport, diff them,
// and print the report — six commands' worth in one.
import { die } from '../core/errors.ts';
import { lockTake, resourceOf } from '../core/hold.ts';
import { ab } from '../web/ab.ts';
import { check } from '../web/page.ts';
import { optValue, shots } from '../web/shots.ts';
import { run as report } from './report.ts';

export async function run(args: string[]): Promise<void> {
  const [persona, name] = args;
  if (!persona || !name) die('usage: vysu walk <persona> <name> --url <url> [shots options…]');
  const rest: string[] = [];
  let url = '';
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--url') {
      url = optValue(args, i++, 'walk');
      rest.push('--url', url);
    } else if (a !== '--check' && a !== '--no-sheet') {
      // --check is accepted for symmetry: a walk always checks. --no-sheet is a flow's, and a walk
      // makes no sheet unless asked (`vysu sheet <name>`): nothing to turn off.
      rest.push(a);
    }
  }
  if (!url) die('vysu walk: --url is required');
  // Up front rather than on the first call: the waiting line is said once, before anything else.
  await lockTake(resourceOf(persona));
  // This walk answers for itself: whatever the session collected before it is not its business.
  await ab(persona, ['errors', '--clear'], { stderr: 'drop' });
  await ab(persona, ['network', 'requests', '--clear'], { stderr: 'drop' });
  await shots(persona, name, rest, () => undefined);
  await check(persona, name);
  await report([name]);
}
