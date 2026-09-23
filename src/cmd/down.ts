// `vysu down <service> | all | metro | applog [ios|android]`.
import { down } from '../services/services.ts';

export async function run(args: string[]): Promise<void> {
  await down(args);
}
