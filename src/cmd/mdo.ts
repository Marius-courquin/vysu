// `vysu mdo ios|android [options] -- "<step>" … | <file|->`.
import { mdo } from '../mobile/mdo.ts';

export const run = (args: string[]): Promise<number> => mdo(args);
