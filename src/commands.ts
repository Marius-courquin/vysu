// Every command of the engine, by the name typed after `vysu`, loaded on demand.
export interface CommandModule {
  run(args: string[]): Promise<number | void>;
}

export const commands: Record<string, () => Promise<CommandModule>> = {
  frame: () => import('./cmd/frame.ts'),
  help: () => import('./cmd/help.ts'),
  '-h': () => import('./cmd/help.ts'),
  '--help': () => import('./cmd/help.ts'),
  mark: () => import('./cmd/mark.ts'),
  persona: () => import('./cmd/persona.ts'),
  report: () => import('./cmd/report.ts'),
  sheet: () => import('./cmd/sheet.ts'),
  version: () => import('./cmd/version.ts'),
  checker: () => import('./cmd/checker.ts'),
  setup: () => import('./cmd/setup.ts'),
  init: () => import('./cmd/init.ts'),
  up: () => import('./cmd/up.ts'),
  down: () => import('./cmd/down.ts'),
  cut: () => import('./cmd/cut.ts'),
  video: () => import('./cmd/video.ts'),
  update: () => import('./cmd/update.ts'),
  doctor: () => import('./cmd/doctor.ts'),
  shots: () => import('./cmd/shots.ts'),
  walk: () => import('./cmd/walk.ts'),
  flow: () => import('./cmd/flow.ts'),
  rec: () => import('./cmd/rec.ts'),
  lang: () => import('./cmd/lang.ts'),
  check: () => import('./cmd/check.ts'),
  box: () => import('./cmd/box.ts'),
  login: () => import('./cmd/login.ts'),
  mlogin: () => import('./cmd/mlogin.ts'),
  auth: () => import('./cmd/auth.ts'),
  token: () => import('./cmd/token.ts'),
  prune: () => import('./cmd/prune.ts'),
  cache: () => import('./cmd/cache.ts'),
  __prim: () => import('./cmd/__prim.ts'),
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
