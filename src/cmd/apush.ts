// The old spelling of `vysu push <persona> <preset>`, for one minor version.
import { deprecated } from '../core/errors.ts';
import { push } from '../push/push.ts';

export async function run(args: string[]): Promise<void> {
  deprecated('apush', 'vysu push <persona> <preset>');
  await push(args);
}
