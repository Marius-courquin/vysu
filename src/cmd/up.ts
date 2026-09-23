// `vysu up <service> [--env k=v]… | all | ios|android …`: a service declared in the config, started
// and waited for; a device and what runs in front of the app.
import { up } from '../services/services.ts';

export async function run(args: string[]): Promise<void> {
  await up(args);
}
