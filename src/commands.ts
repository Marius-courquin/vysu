// Every command of the engine, by the name typed after `vysu`, loaded on demand.
export interface CommandModule {
  run(args: string[]): Promise<number | void>;
}

export const commands: Record<string, () => Promise<CommandModule>> = {
  help: () => import('./cmd/help.ts'),
  '-h': () => import('./cmd/help.ts'),
  '--help': () => import('./cmd/help.ts'),
  persona: () => import('./cmd/persona.ts'),
  report: () => import('./cmd/report.ts'),
  sheet: () => import('./cmd/sheet.ts'),
  version: () => import('./cmd/version.ts'),
  checker: () => import('./cmd/checker.ts'),
  setup: () => import('./cmd/setup.ts'),
  init: () => import('./cmd/init.ts'),
};

// The engine's own command names, ported or not: a project command of the same name is unreachable,
// and an unknown name is a persona session (`vysu alice open …`).
export const ENGINE_COMMANDS = new Set(
  (
    'login up down ios android mlogin mshot mtap mrelaunch mreload mflow mdo mwait mrec mlog mopen mnet mperm mburst ' +
    'push textsize appearance shots walk flow rec report lang sheet frame cut video box mark check auth persona claim ' +
    'release devices adb simctl prune cache setup init doctor checker update version ipush apush token help -h --help'
  ).split(' '),
);
