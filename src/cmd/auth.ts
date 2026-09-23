// `vysu auth token <persona> | test <persona> [ios|android] | describe`.
import { test, token } from '../auth/commands.ts';
import { context } from '../auth/context.ts';
import { authLoad } from '../auth/load.ts';
import { die } from '../core/errors.ts';

const USAGE = 'usage: vysu auth token <persona> | test <persona> [ios|android] | describe';

export async function printToken(persona: string): Promise<void> {
  const t = await token(persona);
  if (t !== undefined) process.stdout.write(`${t}\n`);
}

export async function run(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'token':
      if (!rest[0]) die('usage: vysu auth token <persona>');
      return printToken(rest[0]);
    case 'describe': {
      const a = await authLoad();
      process.stdout.write(await a.connector.describe(context()));
      return;
    }
    case 'test':
      if (!rest[0]) die('usage: vysu auth test <persona> [ios|android]');
      return test(rest[0], rest[1] ?? '');
    default:
      die(USAGE);
  }
}
