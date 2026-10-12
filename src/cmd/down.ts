// `vysu down <service> | all | metro | applog [ios|android] | idle [--minutes N] [--dry-run]`.
import { down } from '../services/services.ts';

export async function run(args: string[]): Promise<void> {
  if (args[0] === 'idle') return (await import('../mobile/reap.ts')).downIdle(args.slice(1));
  await down(args);
}
