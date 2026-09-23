// `vysu devices [--prune-clones [--dry-run]]`.
import { devicesCommand } from '../mobile/pool.ts';

export const run = (args: string[]): Promise<void> => devicesCommand(args);
