// `vysu mnet ios|android offline|online`.
import { mnet } from '../mobile/mctl.ts';

export const run = async (args: string[]): Promise<number> => ((await mnet(args[0] ?? '', args.slice(1))) ? 0 : 1);
