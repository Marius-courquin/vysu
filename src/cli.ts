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
import { usage } from './cmd/help.ts';

module.enableCompileCache?.();

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  // A leading `--no-color` is the global form (`vysu --no-color doctor`); setup, init and doctor
  // take it among their own options too. Only leading, so a `rec` step that says --no-color stays one.
  if (args[0] === '--no-color') {
    noColor();
    args.shift();
  }
  setCommandLine(args);
  try {
    setConfig(Config.load());
    const name = args[0];
    if (!name) {
      process.stdout.write(usage());
      return 1;
    }
    // Own keys only: `vysu toString` is a persona, not Object.prototype's method.
    const load = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (load) {
      const code = await (await load()).run(args.slice(1));
      return typeof code === 'number' ? code : 0;
    }
    // Any other name is a project command or a persona. The project command wins:
    // `.vysu/commands/seed` is a command the project named, while a persona is only ever a session
    // name. An unknown name is therefore a persona's session, and agent-browser answers for it.
    const file = projectCommandPath(name);
    if (file) return await execProjectCommand(file, args.slice(1));
    return await (await import('./web/passthrough.ts')).passthrough(name, args.slice(1));
  } catch (e) {
    if (e instanceof Exit) return e.code;
    if (e instanceof VysuError) {
      printError(e);
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`vysu: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 70;
  },
);
