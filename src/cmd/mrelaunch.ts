// `vysu mrelaunch ios|android [--textsize …] [--appearance …] [--lang <l>]`.
import { die } from '../core/errors.ts';
import { mrelaunch, MRELAUNCH_USAGE } from '../mobile/launch.ts';

export async function run(args: string[]): Promise<void> {
  const p = args[0] ?? '';
  if (p !== 'ios' && p !== 'android') die(MRELAUNCH_USAGE);
  await mrelaunch(p, args.slice(1));
}
