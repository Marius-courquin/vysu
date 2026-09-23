// Parity of the auth connectors (test/parity/web.ts runs them against VYSU_REF): a login form served
// on 127.0.0.1, scratch projects around it, and each connector form — built-in `none` and `form`, a
// project's bash `.vysu/auth.sh` (sourced by the reference, run through the bridge by this engine),
// and a project's `.vysu/auth.mjs` (this engine) against the same connector written in bash (the
// reference, which reads only that one). Personas and sessions are the scratch project's own
// (`lotweb-<persona>`).
//
//   node test/parity/auth-cases.ts [--only <case,…>]
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { main, scratch, type Case } from './web.ts';

const ENGINE = resolve(import.meta.dirname, '..', '..');
const server = spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'form-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise<string>((ok) => server.stdout.once('data', (b: Buffer) => ok(b.toString().trim())));
const origin = `http://127.0.0.1:${port}`;

const state = join(scratch, 'state');
mkdirSync(state, { recursive: true });
writeFileSync(
  join(state, 'personas.env'),
  "VYSU_PERSONA_ALICE_EMAIL='alice@example.com'\nVYSU_PERSONA_ALICE_PASSWORD='s3cret'\nVYSU_PERSONA_BOB_EMAIL='bob@example.com'\nVYSU_PERSONA_BOB_PASSWORD='wrong'\n",
  { mode: 0o600 },
);
function project(name: string, files: Record<string, string>, extra = ''): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, '.vysu'), { recursive: true });
  writeFileSync(
    join(dir, '.vysu', 'config'),
    `VYSU_PROJECT='lotweb'\nVYSU_STATE='${state}'\nVYSU_ORIGIN='${origin}'\nVYSU_LOGIN_PATH='/login'\n${extra}`,
  );
  for (const [to, from] of Object.entries(files)) copyFileSync(from, join(dir, '.vysu', to));
  return dir;
}
const sh = join(ENGINE, 'connectors', 'auth', 'example.sh');
const mjs = join(ENGINE, 'connectors', 'auth', 'example.mjs');
const plain = project('proj-plain', {});
const bash = project('proj-sh', { 'auth.sh': sh });
const both = project('proj-both', { 'auth.sh': sh, 'auth.mjs': mjs });
const token = "VYSU_FORM_TOKEN_JS=\"localStorage.getItem('access_token')\"\n";
const formProject = project('proj-form', {}, `VYSU_AUTH='form'\n${token}`);

// agent-browser's own « ✗ Wait timed out » line: the bash template's `web … || die` lets it through,
// the module's `webTry` keeps it.
const verbs = (prefix: string, cwd: string, env: Record<string, string> = {}, ignore: RegExp[] = []): Case[] => [
  { name: `${prefix}/describe`, args: ['auth', 'describe'], cwd, env },
  { name: `${prefix}/login`, args: ['login', 'alice'], cwd, env },
  { name: `${prefix}/token`, args: ['auth', 'token', 'alice'], cwd, env },
  { name: `${prefix}/token-alias`, args: ['token', 'alice'], cwd, env },
  { name: `${prefix}/test`, args: ['auth', 'test', 'alice'], cwd, env },
  { name: `${prefix}/refused`, args: ['login', 'bob'], cwd, env, ignore },
  { name: `${prefix}/unknown-persona`, args: ['login', 'carol'], cwd, env },
  { name: `${prefix}/login-url`, args: ['login', 'alice', `${origin}/login`], cwd, env },
];

const cases: Case[] = [
  ...verbs('none', plain),
  ...verbs('form', formProject),
  ...verbs('bash', bash),
  ...verbs('module', both, {}, [/^✗ Wait timed out/]),
  // Deliberate: the message names the built-in's file, now a .ts one.
  { name: 'load/bogus', args: ['auth', 'describe'], cwd: plain, env: { VYSU_AUTH: 'bogus' }, ignore: [/^vysu: no auth connector « bogus »/] },
  { name: 'load/missing-path', args: ['auth', 'describe'], cwd: plain, env: { VYSU_AUTH: 'connectors/mine.sh' } },
  { name: 'load/path', args: ['auth', 'describe'], cwd: plain, env: { VYSU_AUTH: sh } },
  // Deliberate: with no connector in .vysu/, the one expected is the module form vysu init writes.
  { name: 'load/custom-none', args: ['auth', 'describe'], cwd: plain, env: { VYSU_AUTH: 'custom' }, ignore: [/^vysu: no auth connector « custom »/] },
  { name: 'load/no-origin', args: ['login', 'alice'], cwd: plain, env: { VYSU_ORIGIN: '' } },
];

try {
  await main(cases);
} finally {
  server.kill();
}
