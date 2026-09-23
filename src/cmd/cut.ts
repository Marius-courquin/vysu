// `vysu cut <take> --draft [--force]`: the montage script of a take, proposed rather than written.
// The segments come from the steps and from motion.txt (dead time dropped), a freeze from every
// `shot`, an empty chapter per anchor. What stays for the agent is the text — kicker, title, body —
// and nothing in frames or coordinates.
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { tool } from '../img/tools.ts';

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export async function run(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (!name) die('usage: vysu cut <take> --draft [--force]');
  let draft = false;
  let force = false;
  for (const a of rest) {
    if (a === '--draft') draft = true;
    else if (a === '--force') force = true;
    else die(`vysu cut: unknown option ${a}`);
  }
  const c = config();
  const dir = join(c.shots, name);
  if (!isDir(dir)) die(`no shots folder ${dir}`);
  if (!draft) die(`vysu cut: --draft is the only mode (write the rest of ${dir}/cut.json by hand)`);
  if (!existsSync(join(dir, 'events.json'))) die(`vysu cut: no ${dir}/events.json — record the take with vysu rec / vysu mrec`);
  // The draft names the project's theme and language: the helper reads them from the environment,
  // so every value of the config is exported to it first.
  Object.assign(process.env, c.childEnv({ VYSU_LANG: c.get('LANG') || undefined }));
  const out = join(dir, 'cut.json');
  const r = await tool('take', ['draft', '--dir', dir, '--take', name]);
  process.stderr.write(r.stderr);
  if (existsSync(out) && !force) {
    process.stdout.write(r.stdout);
    die(`vysu cut: ${out} already exists (--force to overwrite)`);
  }
  writeFileSync(out, r.stdout);
  process.stdout.write(r.stdout);
  return r.code;
}
