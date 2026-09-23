// `vysu token <persona>`: the old spelling of `vysu auth token`, for one minor version.
import { deprecated, die } from '../core/errors.ts';
import { printToken } from './auth.ts';

export async function run(args: string[]): Promise<void> {
  deprecated('token', 'vysu auth token <persona>');
  if (!args[0]) die('usage: vysu auth token <persona>');
  await printToken(args[0]);
}
