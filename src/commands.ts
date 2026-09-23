// Every command of the engine, by the name typed after `vysu`, loaded on demand.
export interface CommandModule {
  run(args: string[]): Promise<number | void>;
}

export const commands: Record<string, () => Promise<CommandModule>> = {
  report: () => import('./cmd/report.ts'),
  sheet: () => import('./cmd/sheet.ts'),
};
