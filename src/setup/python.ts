// python3 with numpy and Pillow, for as long as something still needs it: a helper of py/ not yet
// ported to TypeScript, or a command the bash engine still runs (its inline `python3 -c` too).
// When the last one goes, so does this file and its one call in setup and in doctor.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { which } from '../core/host.ts';
import { run } from '../core/proc.ts';
import { miss, ok } from '../core/ui.ts';
import { isPorted, type Tool } from '../img/tools.ts';
import { installHint } from './hints.ts';

const HELPERS: Tool[] = ['burst', 'compare', 'diff', 'fields', 'frame', 'mark', 'motion', 'screen', 'screencap', 'stitch', 'take', 'verdict'];

export function pythonNeeded(): boolean {
  return existsSync(join(ENGINE, 'legacy', 'vysu')) || HELPERS.some((h) => !isPorted(h));
}

// One start of the interpreter answers both questions: are the modules there, and which version.
// Started early and read when its line comes: the interpreter takes the better part of a second.
export type PythonProbe = { ok: boolean; version: string } | undefined;

export async function pythonProbe(): Promise<PythonProbe> {
  if (!pythonNeeded()) return undefined;
  const py = which('python3') || which('python');
  if (!py) return { ok: false, version: '' };
  const r = await run(py, ['-c', 'import numpy, PIL, sys; print(sys.version.split()[0])']);
  return { ok: r.code === 0, version: r.stdout.trim() };
}

export function pythonReport(probe: PythonProbe, withVersion: boolean): void {
  if (!probe) return;
  if (probe.ok) ok(`python3: numpy + pillow${withVersion ? ` (${probe.version})` : ''}`);
  else miss('python3: numpy / pillow missing — no diff, no contact sheet, no export', installHint('python'));
}
