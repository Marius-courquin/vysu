// vysu — look at a real app the way a reviewer does. The entry point: the leading --no-color, the
// config, then the command. Each command lives in its own module, loaded only when it is the one
// asked for, so a `vysu report` never pays for the mobile code.
import module from 'node:module';
import { Config } from './core/config.ts';
import { legacy } from './core/legacy.ts';
import { setCommandLine, setConfig } from './core/ctx.ts';
import { Exit, printError, runCleanups, VysuError } from './core/errors.ts';
import { noColor } from './core/ui.ts';
import { commands } from './commands.ts';

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
    const load = name ? commands[name] : undefined;
    if (!load) return await legacy(args);
    const code = await (await load()).run(args.slice(1));
    return typeof code === 'number' ? code : 0;
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

// A signal ends the command the way a die does: locks given back, a recorder stopped.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
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
