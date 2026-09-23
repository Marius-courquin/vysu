// `vysu ios <agent-device args…>`: agent-device on the chosen simulator, in its session, under its lock.
import { passthrough } from '../mobile/commands.ts';

export const run = (args: string[]): Promise<number> => passthrough('ios', args);
