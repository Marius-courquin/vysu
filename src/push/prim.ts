// What a `.sh` push driver calls back into the engine for, run on its own: `push_payload <preset>
// k=v…` prints the preset with its placeholders filled, exactly as `vysu push` would send it.
import { Config } from '../core/config.ts';
import { setConfig } from '../core/ctx.ts';
import { Exit, printError, VysuError } from '../core/errors.ts';
import { pushPayload } from './push.ts';

const [verb, ...args] = process.argv.slice(2);
try {
  setConfig(Config.load());
  if (verb !== 'payload' || !args[0]) throw new VysuError('usage: prim.ts payload <preset> [k=v]…');
  process.stdout.write(pushPayload(args[0], args.slice(1)));
} catch (e) {
  if (e instanceof Exit) process.exitCode = e.code;
  else if (e instanceof VysuError) {
    printError(e);
    process.exitCode = e.code;
  } else throw e;
}
