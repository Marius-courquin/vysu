// The old spelling of `vysu push ios <preset>`, for one minor version.
import { deprecated } from '../core/errors.ts';
import { push } from '../push/push.ts';

export async function run(args: string[]): Promise<void> {
  deprecated('ipush', 'vysu push ios <preset>');
  await push(['ios', ...args]);
}
