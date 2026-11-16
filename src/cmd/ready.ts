// `vysu ready ios|android [<persona>] [--isolated] [--device <name> | --avd <name>]`: a device ready
// to drive, in one call. Every checker opened with the same five commands — doctor, devices, claim,
// up, mlogin — one turn each: a median of 17 tool calls and 241 s before its first capture, and 30 %
// of all the time spent in mobile commands (126 checkers, October sessions). Each step is the command
// itself, run as it would be typed, so it says and refuses exactly what that command does; a step
// already done answers that it is (a device this owner holds, an app up on its Metro, a persona
// already signed in).
import { spawn } from 'node:child_process';
import { die } from '../core/errors.ts';
import { ownerDevices, type Platform } from '../core/hold.ts';

const USAGE = 'usage: vysu ready ios|android [<persona>] [--isolated] [--device "<simulator>" | --avd <name>]';

function step(args: string[]): Promise<number> {
  process.stdout.write(`— vysu ${args.join(' ')}\n`);
  return new Promise((done) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], { stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('exit', (code) => done(code ?? 1));
  });
}

export async function run(args: string[]): Promise<number> {
  const p = args[0] as Platform;
  if (p !== 'ios' && p !== 'android') die(USAGE);
  let persona = '';
  let isolated = false;
  let device = '';
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--isolated') isolated = true;
    else if (a === '--device' || a === '--avd') {
      if ((a === '--device') !== (p === 'ios')) die(`vysu ready ${p}: ${a} names ${a === '--device' ? 'a simulator' : 'an emulator'}`, USAGE);
      device = args[++i] ?? '';
      if (!device) die(`vysu ready ${p}: ${a} needs a value`, USAGE);
    } else if (a.startsWith('-') || persona) die(`vysu ready ${p}: unknown option ${a}`, USAGE);
    else persona = a;
  }
  // A device this owner already holds is kept (the plain claim renews it): --any would take a second
  // one, and from two on every command has to name its own.
  const held = ownerDevices(p).length > 0;
  const claim = device ? ['claim', p, p === 'ios' ? '--device' : '--avd', device] : held ? ['claim', p] : ['claim', p, '--any'];
  const steps = [claim, ['up', p, ...(isolated ? ['--isolated'] : [])], ...(persona ? [['mlogin', p, persona]] : [])];
  for (const s of steps) {
    const code = await step(s);
    if (code !== 0) {
      process.stdout.write(`ready: ${p} stopped at « vysu ${s.join(' ')} » (exit ${code}); the steps before it held\n`);
      return code;
    }
  }
  process.stdout.write(`ready: ${p}${persona ? ` as ${persona}` : ''} — drive it with vysu mdo ${p} …, hand it back with vysu release ${p} --reset\n`);
  return 0;
}
