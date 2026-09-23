// The reference engine every parity script compares this one against: a bash vysu named by
// VYSU_REF (test/parity/README.md). ref.sh says the same to the shell scripts.
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';

export const REF_UNSET =
  'VYSU_REF is not set: the bash vysu to compare against (git archive v0.5.1 | tar -x -C <dir>, then VYSU_REF=<dir>/bin/vysu)';

export function ref(): string {
  const r = process.env.VYSU_REF;
  if (!r) {
    process.stderr.write(`${REF_UNSET}\n`);
    process.exit(2);
  }
  try {
    accessSync(r, constants.X_OK);
  } catch {
    process.stderr.write(`VYSU_REF: ${r} is not an executable vysu\n`);
    process.exit(2);
  }
  return resolve(r);
}
