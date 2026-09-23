// `vysu android <agent-device args…>`: agent-device on the chosen emulator, addressed by its serial.
import { passthrough } from '../mobile/commands.ts';

export const run = (args: string[]): Promise<number> => passthrough('android', args);
