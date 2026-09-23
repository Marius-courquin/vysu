// `vysu mflow ios|android <file|-> [--shots <name>] [--keep-going]`.
import { mflow } from '../mobile/mdo.ts';

export const run = (args: string[]): Promise<number> => mflow(args);
