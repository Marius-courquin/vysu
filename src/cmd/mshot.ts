// `vysu mshot ios|android <name> [label] [--baseline <name>] [--no-prev] [--full …]`.
import { mshot } from '../mobile/shot.ts';

export const run = async (args: string[]): Promise<number> => ((await mshot(args[0] ?? '', args.slice(1))) ? 0 : 1);
