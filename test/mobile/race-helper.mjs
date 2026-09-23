// One contender of the races in race.test.ts, run as the owner VYSU_OWNER names. `metro <dir>`:
// reserve an isolated Metro's port and print it. `claim <resource>`: claim it, print « claimed ».
// `slow-claim <resource>`: what a claim racing it does, slowly — the pool lock, a pause, the claim.
const [what, arg] = process.argv.slice(2);
const { runCleanups, VysuError } = await import('../../src/core/errors.ts');
try {
  if (what === 'metro') {
    const { metroReserve } = await import('../../src/mobile/metro.ts');
    process.stdout.write(`${await metroReserve('android', '', arg)}\n`);
  } else if (what === 'claim') {
    const { claimSeal } = await import('../../src/mobile/claims.ts');
    await claimSeal(arg, 20, '', '');
    process.stdout.write('claimed\n');
  } else {
    const { claimWrite, lockDrop, lockTake } = await import('../../src/core/hold.ts');
    const pool = `pool-${arg.slice(0, arg.indexOf('-'))}`;
    await lockTake(pool);
    await new Promise((r) => setTimeout(r, 800));
    claimWrite(arg, 20, '', '');
    lockDrop(pool);
    process.stdout.write('claimed\n');
  }
} catch (e) {
  if (!(e instanceof VysuError)) throw e;
  process.stdout.write(`died: ${e.message}\n`);
} finally {
  await runCleanups();
}
