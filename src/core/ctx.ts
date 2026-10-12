// The one invocation this process is: its config, the command line other agents read in a lock
// (« vysu mdo android … »), and who it runs for. Set once by the entry point; tests set their own.
import { Config } from './config.ts';

let current: Config | undefined;
let line = 'vysu';
let argv: string[] = [];

export function setConfig(c: Config): void {
  current = c;
}

export function config(): Config {
  if (!current) current = Config.load();
  return current;
}

export function setCommandLine(args: string[]): void {
  argv = [...args];
  line = `vysu ${args.join(' ')}`.slice(0, 120);
}

// The arguments whole: the line above is cut at 120 characters.
export function commandArgs(): string[] {
  return argv;
}

export function commandLine(): string {
  return line;
}
