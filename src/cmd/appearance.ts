// `vysu appearance ios|android light|dark`.
import { appearance } from '../mobile/settings.ts';

export const run = (args: string[]): Promise<void> => appearance(args[0] ?? '', args[1] || 'light');
