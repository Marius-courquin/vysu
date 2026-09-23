// One contender of the races in race.test.ts, run as the owner VYSU_OWNER names. `metro <dir>`:
// reserve an isolated Metro's port and print it.
const [what, arg] = process.argv.slice(2);
const { runCleanups, VysuError } = await import('../../src/core/errors.ts');
try {
  if (what === 'metro') {
    const { metroReserve } = await import('../../src/mobile/metro.ts');
    process.stdout.write(`${await metroReserve('android', '', arg)}\n`);
  }
} catch (e) {
  if (!(e instanceof VysuError)) throw e;
  process.stdout.write(`died: ${e.message}\n`);
} finally {
  await runCleanups();
}
