// `vysu release ios|android|<persona> [--force] [--reset] [--delete-clone]`.
import { release } from '../mobile/claims.ts';

export const run = (args: string[]): Promise<void> => release(args);
