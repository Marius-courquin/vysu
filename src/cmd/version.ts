// `vysu version`: the engine's version, its sha and where it lives, then the two drivers against the
// versions this engine was checked with.
import { ENGINE } from '../core/config.ts';
import { engineSha, engineVersion, TOOLS, toolMax, toolMin, toolVersion } from '../setup/engine.ts';

export async function run(): Promise<void> {
  const [sha, ...versions] = await Promise.all([engineSha(), ...TOOLS.map((t) => toolVersion(t))]);
  const lines = [`vysu ${engineVersion()} (${sha}) — ${ENGINE}`];
  // The two drivers are half of what vysu is: a version report that leaves them out answers the
  // wrong question when a capture behaves differently on two machines.
  for (const [i, tool] of TOOLS.entries()) lines.push(`${tool} ${versions[i] || 'MISSING'} (needs >= ${toolMin(tool)}${toolMax(tool) ? `, <= ${toolMax(tool)}` : ''})`);
  process.stdout.write(`${lines.join('\n')}\n`);
}
