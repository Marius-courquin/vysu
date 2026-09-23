// `vysu frame <name|file> [--device …] [--preset framed|pitch] [--bg …] [--title …] [--caption …] …`:
// a capture or a clip turned into something to show — a drawn device frame around a screen, a 16:9
// slide for a deck. A shots folder name or a file path, and whatever the frame helper accepts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { toolPassthrough } from '../img/tools.ts';

export function run(args: string[]): Promise<number> {
  const given = args[0];
  if (!given) die('usage: vysu frame <name|file> [frame options…]');
  let target = given;
  if (!existsSync(target)) target = join(config().shots, given);
  if (!existsSync(target)) die(`no shots folder nor file « ${given} »`);
  return toolPassthrough('frame', [target, ...args.slice(1)]);
}
