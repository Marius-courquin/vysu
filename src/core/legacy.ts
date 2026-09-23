// The bash engine, for the commands this one does not run yet. It goes when the last one is ported.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE } from './config.ts';
import { VysuError } from './errors.ts';

export function legacy(args: string[]): Promise<number> {
  const script = join(ENGINE, 'legacy', 'vysu');
  if (process.platform === 'win32' || !existsSync(script)) {
    return Promise.reject(new VysuError(`« ${args[0] ?? ''} » is not available in this engine yet`));
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], { stdio: 'inherit' });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', () => resolve(127));
  });
}
