// `vysu adb <args…>`: adb on this owner's emulator, under its lock.
import { adbCommand } from '../mobile/pool.ts';

export const run = (args: string[]): Promise<void> => adbCommand(args);
