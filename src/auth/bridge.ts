// A bash auth connector (`.vysu/auth.sh`, or a `.sh` path in VYSU_AUTH), the form every project wrote
// for the bash engine, kept working where there is a bash. Each of its functions runs in a bash that
// sources it under `set -euo pipefail`, as the engine did, with every primitive of the contract
// defined as a call back into vysu (`vysu __prim <name> …`). Those calls hold their locks in this
// process's name (VYSU_LOCK_HOLDER): a session or a device the connector touches stays held between
// two of its calls, and is given back when this command ends, whichever way it ends.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { die, exit } from '../core/errors.ts';
import { owner, releaseOnExit } from '../core/hold.ts';
import { which } from '../core/host.ts';
import type { RunResult } from '../core/proc.ts';
import { shellQuote } from '../core/shellenv.ts';
import { authTestSessionName } from '../web/ab.ts';
import { stepsAreOn } from './context.ts';
import type { AuthConnector } from './types.ts';

// The primitives, then the few engine functions the connectors written for the bash engine reached
// for beyond the contract (the built-in ones locked the device and reversed Metro's port themselves).
const PRIMITIVES = `
cfg() { local _k="VYSU_$1"; printf '%s' "\${!_k:-\${2:-}}"; }
die() { printf 'vysu: %s\\n' "$1" >&2; shift; [ $# -eq 0 ] || printf 'next: %s\\n' "$*" >&2; exit 1; }
log() { echo "vysu: $*" >&2; }
step() { [ "$VYSU__STEPS" = 1 ] || return 0; echo "step: $* ok"; }
web() { _vysu web "$@"; }
web_click_any() { _vysu web_click_any "$@"; }
mob() { _vysu mob "$@"; }
mob_press_if() { _vysu mob_press_if "$@"; }
mob_press_any() { _vysu mob_press_any "$@"; }
mob_press_all() { _vysu mob_press_all "$@"; }
mob_wait_text() { _vysu mob_wait_text "$@"; }
mob_fields() { _vysu mob_fields "$@"; }
mobile_app() { _vysu mobile_app "$@"; }
mobile_load_bundle() { _vysu mobile_load_bundle "$@"; }
mstate_set() { _vysu mstate_set "$@"; }
persona_var() { _vysu persona_var "$@"; }
persona_require() { local _a; _a="$(_vysu persona_require "$1")" || exit $?; eval "$_a"; }
ios_lock() { _vysu mobile_prepare ios; }
android_lock() { _vysu mobile_prepare android; }
android_select() { _vysu mobile_prepare android; }
metro_port() { cfg METRO_PORT 8081; }
`;

export function bridgeScript(): string {
  const c = config();
  const self = [process.execPath, ...process.execArgv, join(ENGINE, 'src', 'cli.ts')].map(shellQuote).join(' ');
  // The values in force, as the shell variables a connector of the bash engine could read — not
  // exported: the vysu each primitive starts reads the config itself, and a value handed down in its
  // environment would count as set there on purpose (a Metro port, a device).
  const vars = [...c.values].filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return ['set -euo pipefail', ...vars, `_vysu() { ${self} __prim "$@"; }`, PRIMITIVES, '. "$VYSU__CONNECTOR"', '"$@"', ''].join('\n');
}

export function bridgeEnv(file: string): NodeJS.ProcessEnv {
  const c = config();
  const env: NodeJS.ProcessEnv = { ...process.env };
  // What the files assigned outside vysu's own keys reached every process the engine started.
  for (const [k, v] of c.fileVars) if (!k.startsWith('VYSU_') && !(k in env)) env[k] = v;
  Object.assign(env, {
    VYSU_ENGINE: ENGINE,
    VYSU_PROJECT_DIR: c.projectDir,
    VYSU_DIR: c.vysuDir,
    ...releaseOnExit(),
    VYSU_OWNER: owner(),
    VYSU__CONNECTOR: file,
    VYSU__STEPS: stepsAreOn() ? '1' : '0',
  });
  if (c.configFile) env.VYSU_CONFIG = c.configFile;
  if (authTestSessionName()) env.VYSU_AUTH_TEST_SESSION = authTestSessionName();
  return env;
}

function call(file: string, fn: string, args: string[], capture: boolean): Promise<RunResult> {
  const bash = which('bash');
  if (!bash) die(`${file} is a bash connector, and this machine has no bash`, 'write it as .vysu/auth.mjs (connectors/auth/example.mjs)');
  return new Promise((resolve) => {
    const child = spawn(bash, ['-c', bridgeScript(), 'vysu-auth', fn, ...args], {
      env: bridgeEnv(file),
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    const out: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.on('error', () => resolve({ code: 127, stdout: '', stderr: '' }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), stdout: Buffer.concat(out).toString('utf8'), stderr: '' }));
  });
}

export function bashConnector(file: string): AuthConnector {
  const must = async (fn: string, args: string[], capture = false): Promise<string> => {
    const r = await call(file, fn, args, capture);
    if (r.code !== 0) {
      process.stdout.write(r.stdout);
      exit(r.code);
    }
    return r.stdout;
  };
  return {
    describe: async () => (await must('auth_describe', [], true)).replace(/\n+$/, ''),
    webLogin: async (_v, persona, url) => void (await must('auth_web_login', [persona, url])),
    async webToken(_v, persona) {
      const out = await must('auth_web_token', [persona], true);
      return out === '' ? undefined : out.replace(/\n$/, '');
    },
    mobileLogin: async (_v, platform, persona) => void (await must('auth_mobile_login', [platform, persona])),
    mobileLogout: async (_v, platform) => (await call(file, 'auth_mobile_logout', [platform], false)).code === 0,
  };
}
