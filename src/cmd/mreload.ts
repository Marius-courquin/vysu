// `vysu mreload ios|android`: this device's JS only, reloaded in place.
import { mreload } from '../mobile/reload.ts';

export const run = (args: string[]): Promise<void> => mreload(args);
