// `vysu help`: the usage, which is the header the bash entry point always printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function usage(): string {
  return readFileSync(join(import.meta.dirname, '..', 'usage.txt'), 'utf8');
}

export async function run(): Promise<void> {
  process.stdout.write(usage());
}
