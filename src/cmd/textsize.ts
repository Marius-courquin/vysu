// `vysu textsize ios|android normal|large|xl`.
import { textsize } from '../mobile/settings.ts';

export const run = (args: string[]): Promise<void> => textsize(args[0] ?? '', args[1] || 'normal');
