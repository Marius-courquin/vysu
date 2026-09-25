// `vysu claim <persona> --any`: a session of the persona nobody is using, so several agents checking
// as the same persona work side by side instead of taking turns on one browser. The persona's own
// session first, then `<persona>@2`, `@3`… up to VYSU_WEB_SLOTS. A tab would not do: every command
// of an agent-browser session goes to its one active tab, and two agents switching it under each
// other capture each other's page.
import { existsSync, rmSync } from 'node:fs';
import { login, token } from '../auth/commands.ts';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { claimField, claimFile, claimWhy, claimWrite, lockBusy, lockDrop, lockTake, owner } from '../core/hold.ts';
import { personaRefName, personaSlot, webResource } from '../core/personas.ts';
import { hhmm, sleep } from '../core/text.ts';
import { abRaw, restoreFile, sessionOf } from './ab.ts';
import { webClaimState } from './api.ts';

export function webSlots(): number {
  const v = config().get('WEB_SLOTS');
  if (!/^[1-9][0-9]?$/.test(v)) die(`VYSU_WEB_SLOTS is a number of sessions from 1 to 99 (got « ${v} »)`);
  return Number(v);
}

interface Pick {
  ref: string;
  busy: string[];
}

// The first slot with no live claim — this owner's included: the sub-agents of one session are one
// owner, and each of them must get a session of its own — and no command running on it.
async function pickSlot(base: string): Promise<Pick> {
  const busy: string[] = [];
  for (let s = 1; s <= webSlots(); s++) {
    const ref = personaRefName(base, s);
    const r = webResource(ref);
    const why = claimWhy(r);
    if (why) {
      busy.push(`${ref}: ${why}`);
      continue;
    }
    if (existsSync(claimFile(r))) {
      busy.push(`${ref}: claimed by ${owner()} until ${hhmm(Number(claimField(claimFile(r), 'until') || 0))} (this session, maybe a sibling agent)`);
      continue;
    }
    const running = await lockBusy(r);
    if (running) {
      busy.push(`${ref}: ${running}`);
      continue;
    }
    return { ref, busy };
  }
  return { ref: '', busy };
}

// Never saved, or saved with no token in it (a login that failed half way, a logout). A connector with
// no token to give (a static site, a cookie session) is taken at its word once the session exists.
async function needsLogin(ref: string): Promise<boolean> {
  if (!existsSync(restoreFile(sessionOf(ref)))) return true;
  return (await token(ref)) === '';
}

export async function claimAnyWeb(persona: string, minutes: number, note: string, nowait: boolean): Promise<void> {
  const { base, slot } = personaSlot(persona);
  if (slot > 1) die(`vysu claim: --any picks the slot, ${persona} names one: not both`, `vysu claim ${base} --any`);
  const start = Date.now();
  const wait = config().lockWait;
  let said = false;
  let pick: Pick;
  for (;;) {
    // Two `--any` at the same moment would pick the same slot: the choice and the claim that seals it
    // are made under the pool lock a plain `vysu claim <persona>` seals under too.
    await lockTake('pool-web');
    pick = await pickSlot(base);
    if (pick.ref) {
      claimWrite(webResource(pick.ref), minutes, note, pick.ref);
      lockDrop('pool-web');
      break;
    }
    lockDrop('pool-web');
    const waited = Math.floor((Date.now() - start) / 1000);
    const list = (): void => pick.busy.forEach((l) => process.stderr.write(`  ${l}\n`));
    if (nowait || waited >= wait) {
      process.stderr.write(`vysu: every ${base} session is in use${said ? ` after ${waited}s` : ''} (VYSU_WEB_SLOTS=${webSlots()}):\n`);
      list();
      die(`no free ${base} session`, `vysu claim ${base} --any (waits VYSU_LOCK_WAIT=${wait}s for one; VYSU_WEB_SLOTS raises the count)`);
    }
    if (!said) {
      process.stderr.write(`vysu: every ${base} session is in use, waiting up to ${wait}s (VYSU_LOCK_WAIT):\n`);
      list();
      said = true;
    }
    await sleep(3000);
  }
  const ref = pick.ref;
  const r = webResource(ref);
  // A slot with no login of its own gets one now, with the persona's credentials, in its own session;
  // never a copy of the persona's (see personaSlot).
  let done = '';
  // The anonymous session (`-`, `-@2`…) is a public page: nothing to log in to.
  if (base !== '-' && (await needsLogin(ref))) {
    process.stderr.write(`vysu: ${ref} holds no login: logging in as ${base}, in a session of its own…\n`);
    try {
      await login(ref, '');
    } catch (e) {
      // Half a login saved would read as a login at the next claim.
      await abRaw(['--session', sessionOf(ref), 'close'], { stderr: 'drop' });
      rmSync(restoreFile(sessionOf(ref)), { force: true });
      rmSync(claimFile(r), { force: true });
      throw e;
    }
    done = `logged in as ${base} (its own login, kept from now on)`;
  }
  const f = claimFile(r);
  console.log(`claimed: ${r} until ${hhmm(Number(claimField(f, 'until') || 0))} by ${claimField(f, 'owner')} (vysu release ${ref})`);
  console.log(`name it: every command of this task names ${ref} — vysu walk ${ref} …, vysu ${ref} <agent-browser args>, vysu release ${ref}`);
  if (done) console.log(`session: ${done}`);
  console.log(await webClaimState(ref));
}
