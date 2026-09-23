// `vysu mwait ios|android "<text>" [--gone] [--timeout <s>] | --idle [--timeout <s>]`.
import { mwait } from '../mobile/mdo.ts';

export const run = (args: string[]): Promise<number> => mwait(args);
