// Which auth connector the project named, loaded once: a built-in (`none`, `auth0`, `form`), the
// project's own `.vysu/auth.mjs|.js|.ts` (a module exporting the connector's functions, which runs
// wherever vysu runs), or a bash one (`.vysu/auth.sh`, or `VYSU_AUTH` naming a `.sh` path), run
// through the bridge on a machine that has bash.
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { bashConnector } from './bridge.ts';
import { context } from './context.ts';
import type { AuthConnector } from './types.ts';

export interface Loaded {
  // What `vysu auth test` and doctor call it: the name the config gave, `custom`, or the path.
  name: string;
  file: string;
  connector: AuthConnector;
}

const BUILT_IN: Record<string, () => Promise<{ connector: AuthConnector }>> = {
  none: () => import('../connectors/auth/none.ts'),
  auth0: () => import('../connectors/auth/auth0.ts'),
  form: () => import('../connectors/auth/form.ts'),
};
const PROJECT_FORMS = ['auth.mjs', 'auth.js', 'auth.ts', 'auth.sh'];
const JS = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts']);

function projectConnector(): string {
  const dir = config().vysuDir;
  if (!dir) return '';
  for (const f of PROJECT_FORMS) if (existsSync(join(dir, f))) return join(dir, f);
  return '';
}

async function fromModule(file: string): Promise<AuthConnector> {
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const c = (mod.default && typeof mod.default === 'object' ? mod.default : mod) as Partial<AuthConnector>;
  for (const fn of ['describe', 'webLogin', 'webToken', 'mobileLogin'] as const) {
    if (typeof c[fn] !== 'function') die(`${file}: an auth connector exports describe, webLogin, webToken and mobileLogin (no ${fn})`);
  }
  return c as AuthConnector;
}

let loaded: Loaded | undefined;

export async function authLoad(): Promise<Loaded> {
  if (loaded) return loaded;
  const c = config();
  let named = c.get('AUTH');
  // A project that dropped an auth connector in `.vysu/` and named none means that one.
  if (c.origin('AUTH') === 'default' && projectConnector()) named = 'custom';
  let file: string;
  if (named === 'custom') {
    file = projectConnector() || join(c.vysuDir, 'auth.mjs');
  } else if (named.includes('/')) {
    file = c.projectPath(named);
  } else {
    const load = BUILT_IN[named];
    if (!load) die(`no auth connector « ${named} » (${join(import.meta.dirname, '..', 'connectors', 'auth', `${named}.ts`)})`);
    loaded = { name: named, file: named, connector: (await load()).connector };
    return loaded;
  }
  if (!existsSync(file)) die(`no auth connector « ${named} » (${file})`);
  const connector = JS.has(extname(file).toLowerCase()) ? await fromModule(file) : bashConnector(file);
  loaded = { name: named, file, connector };
  return loaded;
}

// For doctor: the connector's own one-liner, and whether anyone chose it.
export async function authDescribeLine(): Promise<string> {
  const c = config();
  if (c.get('AUTH') === 'none' && c.origin('AUTH') === 'default' && !projectConnector()) return 'auth: none (default)';
  const a = await authLoad();
  return `auth: ${a.name} — ${await a.connector.describe(context())}`;
}
