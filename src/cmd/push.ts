// `vysu push ios <preset>` · `vysu push <persona> <preset> [--platform ios|android] [--field k=v]…`.
import { push } from '../push/push.ts';

export const run = (args: string[]): Promise<void> => push(args);
