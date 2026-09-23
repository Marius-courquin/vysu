// `vysu mrec ios|android <name> [--fps 60] [--crop x,y,w,h] [--strict] -- "<step>" …`.
import { mrec } from '../mobile/rec.ts';

export const run = (args: string[]): Promise<number> => mrec(args);
