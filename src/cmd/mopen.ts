// `vysu mopen ios|android <route|url> [--wait "<text>"] [--timeout <s>]`.
import { mopen } from '../mobile/mctl.ts';

export const run = async (args: string[]): Promise<number> => ((await mopen(args[0] ?? '', args.slice(1))) ? 0 : 1);
