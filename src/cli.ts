// vysu — look at a real app the way a reviewer does. The entry point: the leading --no-color, the
// config, then the command. Each command lives in its own module, loaded only when it is the one
// asked for, so a `vysu report` never pays for the mobile code.
import module from 'node:module';
import { Config } from './core/config.ts';
import { setCommandLine, setConfig } from './core/ctx.ts';
import { Exit, printError, runCleanups, signalForwarded, VysuError } from './core/errors.ts';
import { noColor } from './core/ui.ts';
import { commands } from './commands.ts';
import { execProjectCommand, projectCommandPath } from './core/project.ts';
import { helpAsked, helpFor, usage } from './cmd/help.ts';
import { browserAlias } from './core/aliases.ts';
import { pointAtIsolated, sessionFollows } from './services/isolated.ts';

module.enableCompileCache?.();

// The commands whose --help is someone else's: `vysu ios swipe --help` is agent-device's help for
// swipe, `vysu adb --help` adb's.
const HELP_PASSED_ON = new Set(['ios', 'android', 'adb', 'simctl', '__prim', 'help', '-h', '--help']);

// A die that says how a command is spelled names the full entry too: a usage line is one line, the
// entry says what each option does.
// The commands whose first argument is a persona's browser session (the passthrough too).
const WEB_PERSONA = new Set(['walk', 'shots', 'login', 'flow', 'rec', 'check', 'lang', 'box']);

const USAGE_ERROR = /^usage: |unknown option|unknown service|needs a value|is required/;

async function main(argv: string[]): Promise<number> {
  let args = [...argv];
  // A leading `--no-color` is the global form (`vysu --no-color doctor`); setup, init and doctor
  // take it among their own options too. Only leading, so a `rec` step that says --no-color stays one.
  if (args[0] === '--no-color') {
    noColor();
    args.shift();
  }
  setCommandLine(args);
  const name = args[0];
  // Own keys only: `vysu toString` is a persona, not Object.prototype's method.
  const load = name && Object.hasOwn(commands, name) ? commands[name] : undefined;
  try {
    const c = Config.load();
    setConfig(c);
    if (!name) {
      process.stdout.write(usage());
      return 1;
    }
    // Help is asked of the command, wherever it sits among its arguments: `vysu up --help` was taken
    // for a service, `vysu persona --help` for a persona, `vysu prune --help` for an unknown option
    // (588 help calls and 145 usage errors in the audit of 25/09 → 12/10).
    if (load && !HELP_PASSED_ON.has(name) && helpAsked(args.slice(1))) {
      process.stdout.write(helpFor(name) || usage());
      return 0;
    }
    // An owner that serves the web app from its own worktree (`up <service> --isolated`) sees it in
    // its browser sessions; a session launched for someone else's view is relaunched for this one.
    const rule = pointAtIsolated(c);
    const file = load ? '' : projectCommandPath(name);
    const persona = load ? (WEB_PERSONA.has(name) ? args[1] : undefined) : file ? undefined : name;
    if (persona && (!persona.startsWith('-') || /^-(@\d+)?$/.test(persona))) await sessionFollows(c, persona, rule);
    if (load) {
      const code = await (await load()).run(args.slice(1));
      return typeof code === 'number' ? code : 0;
    }
    // Any other name is a project command or a persona. The project command wins:
    // `.vysu/commands/seed` is a command the project named, while a persona is only ever a session
    // name. An unknown name is therefore a persona's session, and agent-browser answers for it.
    if (file) return await execProjectCommand(file, args.slice(1));
    return await (await import('./web/passthrough.ts')).passthrough(name, browserAlias(args.slice(1)));
  } catch (e) {
    if (e instanceof Exit) return e.code;
    if (e instanceof VysuError) {
      printError(load && !e.next && !HELP_PASSED_ON.has(name!) && USAGE_ERROR.test(e.message) ? new VysuError(e.message, `vysu ${name} --help`, e.code) : e);
      return e.code;
    }
    throw e;
  } finally {
    await runCleanups();
  }
}

// A reader that stops early (`vysu doctor | head`) closes the pipe: the rest of the output has
// nowhere to go, which is an end, not an error. The locks go with the exit hook.
// The recorder a `rec … | head` started is still stopped: the cleanups run before the exit, with
// every further write dropped. 141 is what a shell reports for a command SIGPIPE ended.
let piped = false;
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
    if (piped) return;
    piped = true;
    const drop = ((_: unknown, _enc?: unknown, cb?: unknown) => {
      if (typeof cb === 'function') cb();
      else if (typeof _enc === 'function') _enc();
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = drop;
    process.stderr.write = drop;
    void runCleanups().finally(() => process.exit(141));
  });
}

// A signal ends the command the way a die does: locks given back, a recorder stopped. A project
// command running in vysu's place gets the signal instead, and its end is the command's end.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (signalForwarded(sig)) return;
    void runCleanups().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  });
}

// The exit is explicit, once both streams have flushed: a request still pending in a library
// (a device call past its ceiling), a timer or a socket would otherwise hold the process open after
// the command has said everything it had to.
const flushed = (s: NodeJS.WriteStream): Promise<void> => new Promise((r) => (s.writableLength ? s.write('', () => r()) : r()));
main(process.argv.slice(2)).then(
  async (code) => {
    await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
    process.exit(code);
  },
  async (e: unknown) => {
    process.stderr.write(`vysu: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
    process.exit(70);
  },
);
