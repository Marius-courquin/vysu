// The mobile contract called the way the platform lot's `vysu up` / `vysu down` / `vysu doctor` call
// it, for a parity run before those commands land: `node test/parity/api.ts up android --avd <n>`,
// `… down metro`, `… doctor`, `… push-lines`. Run from the project, like vysu.
import { Config } from '../../src/core/config.ts';
import { setCommandLine, setConfig } from '../../src/core/ctx.ts';
import { Exit, printError, runCleanups, VysuError } from '../../src/core/errors.ts';
import type { Platform } from '../../src/core/hold.ts';
import { mobileDoctorLines, mobileDown, mobileUp, pushDescribeLines } from '../../src/mobile/api.ts';

const [what = '', ...rest] = process.argv.slice(2);
setCommandLine([what, ...rest]);
try {
  setConfig(Config.load());
  if (what === 'up') await mobileUp(rest[0] as Platform, rest.slice(1));
  else if (what === 'down') await mobileDown(rest[0] ?? '', rest.slice(1));
  else if (what === 'doctor') for (const l of await mobileDoctorLines()) console.log(l);
  else if (what === 'push-lines') for (const l of await pushDescribeLines()) console.log(l);
  else throw new VysuError('usage: node test/parity/api.ts up|down|doctor|push-lines …');
} catch (e) {
  if (e instanceof Exit) process.exitCode = e.code;
  else if (e instanceof VysuError) {
    printError(e);
    process.exitCode = e.code;
  } else throw e;
} finally {
  await runCleanups();
}
