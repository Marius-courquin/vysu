// `vysu mlog [ios|android] [--device] [--errors] [mark | --tail N]`.
import { mlog } from '../mobile/mlog.ts';

export const run = (args: string[]): Promise<void> => mlog(args);
