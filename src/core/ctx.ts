// The one invocation this process is: its config, the command line other agents read in a lock
// (« vysu mdo android … »), and who it runs for. Set once by the entry point; tests set their own.
import { Config } from './config.ts';

let current: Config | undefined;
let line = 'vysu';

export function setConfig(c: Config): void {
  current = c;
}

export function config(): Config {
  if (!current) current = Config.load();
  return current;
}

export function setCommandLine(args: string[]): void {
  line = `vysu ${args.join(' ')}`.slice(0, 120);
}

export function commandLine(): string {
  return line;
}
