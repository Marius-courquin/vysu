// One contender of the lock race in hold.test.ts: take the lock, hold it a moment, log both ends.
const [tag, log] = process.argv.slice(2);
const { lockTake } = await import('../../src/core/hold.ts');
const { runCleanups } = await import('../../src/core/errors.ts');
const { appendFileSync } = await import('node:fs');
await lockTake('web-race');
appendFileSync(log, `${tag} in\n`);
await new Promise((r) => setTimeout(r, 120));
appendFileSync(log, `${tag} out\n`);
await runCleanups();
