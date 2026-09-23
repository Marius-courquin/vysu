// `vysu mburst ios|android <name> [--seconds 3] [--every 0.3] [-- "<step>" …]`.
import { mburst } from '../mobile/mctl.ts';

export const run = async (args: string[]): Promise<number> => ((await mburst(args[0] ?? '', args.slice(1))) ? 0 : 1);
