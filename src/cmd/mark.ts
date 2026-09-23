// `vysu mark <in.png> --out <out.png> [--box x,y,w,h[:label]]… [--grow 10] [--crop x,y,w,h|auto] [--dim] …`:
// boxes, labels, a dimmed surrounding and a crop on a capture, the helper's own command line.
import { toolPassthrough } from '../img/tools.ts';

export function run(args: string[]): Promise<number> {
  return toolPassthrough('mark', args);
}
