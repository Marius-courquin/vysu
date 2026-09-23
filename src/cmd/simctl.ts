// `vysu simctl <verb> [args…]`: xcrun simctl on this owner's simulator, under its lock.
import { simctlCommand } from '../mobile/pool.ts';

export const run = (args: string[]): Promise<void> => simctlCommand(args);
