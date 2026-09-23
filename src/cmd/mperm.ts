// `vysu mperm ios|android <permission> grant|deny|reset`.
import { mperm } from '../mobile/mctl.ts';

export const run = async (args: string[]): Promise<number> => ((await mperm(args[0] ?? '', args.slice(1))) ? 0 : 1);
