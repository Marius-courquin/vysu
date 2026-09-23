// `vysu claim ios|android|<persona> [--minutes 20] [--note …] [--device|--avd <name>] [--any [--no-wait]]`.
import { claim } from '../mobile/claims.ts';

export const run = (args: string[]): Promise<void> => claim(args);
