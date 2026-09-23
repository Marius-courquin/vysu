// `vysu mtap ios|android "<label>" [--wait "<text>"] [--timeout <s>]`.
import type { Platform } from '../core/hold.ts';
import { mtap } from '../mobile/steps.ts';

export const run = async (args: string[]): Promise<number> => ((await mtap((args[0] ?? '') as Platform, args.slice(1))) ? 0 : 1);
