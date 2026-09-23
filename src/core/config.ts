// Where everything starts: the project's `.vysu/config` and the values in force, and the paths under
// $VYSU_STATE. Discovery, in the order the design note gives: an explicit $VYSU_CONFIG (so a config
// can be tried from outside its project), then $VYSU_PROJECT_DIR, then the first ancestor of the
// working directory holding `.vysu/config` — like `.git`. Nothing found is not an error: anonymous
// web captures still work, and only a command needing a persona, a service or a connector says what
// is missing.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { die } from './errors.ts';
import { parseShellEnv, ShellUnsupported } from './shellenv.ts';
import { which } from './host.ts';

export const ENGINE = resolve(import.meta.dirname, '..', '..');
export const HOME = homedir();
export const IOS_DEFAULT_DEVICE = 'iPhone 17 Pro';
export const ANDROID_DEFAULT_AVD = 'vysu_pixel8_api36';
// Models downsize an image before tokenising it (Claude: a 1568 px long edge, then ≈ w×h/750
// tokens; OpenAI: 512 px tiles, the cost following the pixels too). Past that edge a contact sheet
// loses its thumbnails and costs the same: every sheet is rendered to fit inside that square.
export const SHEET_EDGE = 1568;
// The cadence every take is normalized to, and the one the montage renders at: a mobile recorder has
// none of its own, and 30 fps is what the video output asks for.
export const CLIP_FPS = 30;

type Origin = 'env' | 'config' | 'machine.env' | 'devices.env' | 'default';

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// The engine's own defaults are the values nv ran on, minus everything an app decides: an origin, a
// bundle id or a locale folder has no sensible default and stays empty, and the command that needs
// one says so. Order matters: a default may read one set above it.
function defaults(v: Map<string, string>, projectDir: string): Array<[string, string]> {
  const project = v.get('VYSU_PROJECT') || (projectDir ? basename(projectDir) : 'default');
  return [
    ['PROJECT', project],
    ['STATE', join(HOME, '.vysu', project)],
    ['LOGIN_PATH', '/login'],
    ['SIZES', '360x800,768x1024,1280x800,1440x900'],
    ['API_PATTERN', '/api/'],
    // No login until a project names a connector: `login` then opens the url and `auth token`
    // prints nothing, the right answer for a static site, a Storybook and a page behind no door.
    ['AUTH', 'none'],
    ['METRO_PORT', '8081'],
    ['MOBILE_DISMISS_LABELS', 'Continue,Close'],
    // An Expo dev-client served by Metro, or a native app already built: a project that names an
    // Expo folder means expo, anything else — including no mobile app at all — means native.
    ['MOBILE_KIND', v.get('VYSU_MOBILE_DIR') ? 'expo' : 'native'],
    ['IOS_OLD_DEVICE', 'vysu iPhone SE (iOS 18)'],
    // A clone is a whole simulator: 1-2 GB of RAM once booted, hence one by default.
    ['IOS_MAX_CLONES', '1'],
    ['ANDROID_MAX_RUNNING', '2'],
    ['THEME', 'default'],
    ['LOCK_WAIT', '90'],
    [
      'ANDROID_AVDS',
      'vysu_pixel8_api36:36:pixel_8:;vysu_pixel10pro_api36:36:pixel_8_pro:hw.lcd.width=1280 hw.lcd.height=2856 hw.lcd.density=480;vysu_pixel4a_api30:30:pixel_4a:',
    ],
  ];
}

export class Config {
  projectDir = '';
  configFile = '';
  // The folder the loaded config sits in — themes, connectors, push presets and project commands are
  // beside it. It is <project>/.vysu in the ordinary case, and not in the one that matters: a config
  // kept in a worktree while VYSU_PROJECT_DIR stays the checkout its relative paths point into.
  vysuDir = '';
  readonly values = new Map<string, string>();
  // Every variable the files assigned, VYSU_ or not: a settings file is read as if sourced under
  // `set -a`, so each one reaches every process vysu starts.
  readonly fileVars = new Map<string, string>();
  readonly envKeys = new Set<string>();
  private readonly setIn = new Map<string, Origin>();

  static load(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
    const c = new Config();
    c.find(env, cwd);
    for (const [k, v] of Object.entries(env)) if (k.startsWith('VYSU_') && v !== undefined) c.envKeys.add(k);
    // The machine-wide file `vysu setup` writes sits below the project config: a machine says which
    // simulators and which browser it has, a project says which ones it wants. `devices.env` is the
    // name it had until 0.4.0 and is still read, first.
    const files: Array<[string, Origin]> = [
      [join(HOME, '.vysu', 'devices.env'), 'devices.env'],
      [join(HOME, '.vysu', 'machine.env'), 'machine.env'],
    ];
    if (c.configFile) files.push([c.configFile, 'config']);
    for (const [file, origin] of files) {
      if (!isFile(file)) continue;
      for (const [k, v] of readShellEnv(file, (name) => c.fileVars.get(name) ?? env[name])) {
        c.fileVars.set(k, v);
        if (k.startsWith('VYSU_')) c.setIn.set(k, origin);
      }
    }
    // An environment variable wins over the files: `VYSU_ORIGIN=… vysu shots` overrides the config
    // without editing it.
    for (const [k, v] of c.fileVars) if (k.startsWith('VYSU_')) c.values.set(k, v);
    for (const k of c.envKeys) c.values.set(k, env[k] ?? '');
    for (const [k, def] of defaults(c.values, c.projectDir)) {
      if (!c.values.get(`VYSU_${k}`)) c.values.set(`VYSU_${k}`, def);
    }
    return c;
  }

  private find(env: NodeJS.ProcessEnv, cwd: string): void {
    this.projectDir = env.VYSU_PROJECT_DIR ?? '';
    if (env.VYSU_CONFIG) {
      if (!isFile(env.VYSU_CONFIG)) die(`no config file ${env.VYSU_CONFIG} (VYSU_CONFIG)`);
      this.configFile = resolve(cwd, env.VYSU_CONFIG);
      if (!this.projectDir) this.projectDir = resolve(dirname(this.configFile), '..');
    } else if (this.projectDir) {
      if (isFile(join(this.projectDir, '.vysu', 'config'))) this.configFile = join(this.projectDir, '.vysu', 'config');
    } else {
      let dir: string;
      try {
        dir = realpathSync(cwd);
      } catch {
        dir = cwd;
      }
      for (;;) {
        if (isFile(join(dir, '.vysu', 'config'))) {
          this.projectDir = dir;
          this.configFile = join(dir, '.vysu', 'config');
          break;
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
    if (this.configFile) this.vysuDir = dirname(this.configFile);
  }

  // The one reader a connector, a driver and every module use: the value in force, or the default.
  get(key: string, fallback = ''): string {
    return this.values.get(`VYSU_${key}`) || fallback;
  }

  set(key: string, value: string): void {
    this.values.set(`VYSU_${key}`, value);
  }

  // Where a value came from, for `vysu doctor`.
  origin(key: string): Origin {
    const k = `VYSU_${key}`;
    if (this.envKeys.has(k)) return 'env';
    return this.setIn.get(k) ?? 'default';
  }

  get state(): string {
    return this.get('STATE');
  }
  get personas(): string {
    return this.get('PERSONAS', join(this.state, 'personas.env'));
  }
  get shots(): string {
    return this.get('SHOTS', join(this.state, 'shots'));
  }
  get logs(): string {
    return join(this.state, 'logs');
  }
  get locks(): string {
    return join(this.state, 'locks');
  }
  get claims(): string {
    return join(this.state, 'claims');
  }
  get lockWait(): number {
    return Number(this.get('LOCK_WAIT', '90')) || 90;
  }
  get remotion(): string {
    return join(ENGINE, 'remotion');
  }
  get locales(): string {
    return this.projectPath(this.get('LOCALES'));
  }
  get webRepo(): string {
    return this.projectPath(this.get('WEB_REPO'));
  }
  get mobileDir(): string {
    return this.projectPath(this.get('MOBILE_DIR'));
  }
  get androidSdk(): string {
    if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
    if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT;
    if (process.platform === 'darwin') return join(HOME, 'Library', 'Android', 'sdk');
    if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'Android', 'Sdk');
    return join(HOME, 'Android', 'Sdk');
  }

  // A config path, absolute or relative to the project dir: how a config names a folder of its repo.
  projectPath(p: string): string {
    if (!p) return '';
    if (p === '~' || p.startsWith('~/')) return join(HOME, p.slice(1));
    if (isAbsolute(p)) return p;
    return join(this.projectDir || process.cwd(), p);
  }

  // Every command that needs more than an anonymous browser says the same thing when there is no
  // project here: the fix is one command, and it is not a stack trace.
  needProject(): void {
    if (!this.configFile) die('no .vysu/config here (vysu init)');
  }
  need(key: string, why: string): string {
    const v = this.get(key);
    if (!v) {
      this.needProject();
      die(`VYSU_${key} is not set in ${this.configFile} (${why})`);
    }
    return v;
  }

  // The environment a process vysu starts runs in: what the files assigned (all of it, as `set -a`)
  // and the resolved values every helper reads.
  childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of this.fileVars) if (!this.envKeys.has(k)) env[k] = v;
    env.VYSU_ENGINE = ENGINE;
    env.VYSU_PROJECT_DIR = this.projectDir;
    env.VYSU_PROJECT = this.get('PROJECT');
    env.VYSU_STATE = this.state;
    env.VYSU_THEME = this.get('THEME');
    env.VYSU_DIR = this.vysuDir;
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return env;
  }

  // What a project command sees: every resolved VYSU_ value, defaults included.
  exportedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env = this.childEnv();
    for (const [k, v] of this.values) env[k] = v;
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return env;
  }
}

// A settings file read the way a shell sources it. What this reader cannot follow goes to a real
// bash when the machine has one; without one, the line is named.
export function readShellEnv(file: string, lookup: (name: string) => string | undefined): Map<string, string> {
  const text = readFileSync(file, 'utf8');
  const out = new Map<string, string>();
  try {
    for (const a of parseShellEnv(text, lookup, HOME)) out.set(a.key, a.value);
    return out;
  } catch (e) {
    if (!(e instanceof ShellUnsupported)) throw e;
    const bash = process.platform === 'win32' ? '' : which('bash');
    if (!bash) die(`${file}, ${e.message}: vysu reads KEY=value lines, quotes and $VAR; the rest needs bash`);
    const r = spawnSync(bash, ['-c', 'set -a; . "$1" >/dev/null 2>&1; env -0', '_', file], {
      encoding: 'utf8',
      env: process.env,
    });
    if (r.status !== 0) die(`${file}: bash could not read it`);
    const before = process.env;
    for (const pair of r.stdout.split('\0')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      if (before[k] !== v && !['_', 'SHLVL', 'PWD', 'OLDPWD'].includes(k)) out.set(k, v);
    }
    return out;
  }
}

