// `vysu help`: the usage, src/usage.txt as it is (a block of `#` lines, the shape it always had).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function usage(): string {
  return readFileSync(join(import.meta.dirname, '..', 'usage.txt'), 'utf8');
}

export async function run(): Promise<void> {
  process.stdout.write(usage());
}
