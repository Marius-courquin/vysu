// `vysu <name>` with no engine command of that name: the project's own executable in
// `.vysu/commands/`, with everything vysu resolved exported so the command reads the same values the
// engine does. On Windows a file has no executable bit: its shebang, or its extension, says what runs it.
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './ctx.ts';
import { ENGINE } from './config.ts';
import { die } from './errors.ts';
import { bashPath, isWindows, toolArgv, which } from './host.ts';

const EXTENSIONS = ['', '.mjs', '.js', '.ts', '.py', '.sh', '.cmd', '.bat', '.ps1'];

export function projectCommandPath(name: string): string {
  const dir = config().vysuDir;
  if (!dir || !/^[A-Za-z0-9._-]+$/.test(name)) return '';
  for (const ext of EXTENSIONS) {
    const p = join(dir, 'commands', name + ext);
    try {
      if (!statSync(p).isFile()) continue;
      if (!isWindows && ext === '') accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not this one
    }
  }
  return '';
}

// How to start the file: itself where the system can, else through what its shebang or extension names.
// A batch file goes through cmd.exe as one verbatim line with each argument quoted for it (toolArgv):
// handed to cmd.exe as separate arguments, a path with a space broke at the space and an argument's
// `&` started a second command.
function argvFor(file: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  const node = process.execPath;
  const plain = (cmd: string, pre: string[]) => ({ file: cmd, args: [...pre, ...args], verbatim: false });
  if (['.mjs', '.js', '.ts'].includes(ext)) return plain(node, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', file]);
  if (!isWindows && !['.cmd', '.bat', '.ps1'].includes(ext)) return plain(file, []);
  if (ext === '.cmd' || ext === '.bat') return toolArgv(file, args);
  if (ext === '.ps1') return plain('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]);
  const first = readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(first);
  const interp = shebang ? (shebang[1]!.endsWith('/env') ? shebang[2] ?? '' : shebang[1]!.split('/').pop()!) : ext.slice(1);
  if (interp === 'node') return plain(node, [file]);
  if (interp.startsWith('python') || ext === '.py') return plain(which('python3') || which('python') || 'py', [file]);
  if (['bash', 'sh', 'zsh'].includes(interp) || ext === '.sh') {
    const bash = bashPath();
    if (!bash) die(`${file} is a shell script, and this machine has no bash (Git Bash, or WSL)`);
    return plain(bash, [file]);
  }
  die(`${file}: no way to run it here (a shebang or an extension: .mjs, .py, .cmd, .ps1)`);
}

export function execProjectCommand(file: string, args: string[]): Promise<number> {
  const c = config();
  // A device this command named reaches the `vysu ios …` it runs through the environment, which wins.
  // One it did not name is left for each of those calls to resolve: under the same owner they read the
  // same choice, and a guess between two of its devices is refused there, where a device is driven.
  const env = c.exportedEnv({
    VYSU_IOS_DEVICE: c.origin('IOS_DEVICE') === 'env' ? c.get('IOS_DEVICE') : undefined,
    VYSU_ANDROID_AVD: c.origin('ANDROID_AVD') === 'env' ? c.get('ANDROID_AVD') : undefined,
    VYSU_CONFIG_FILE: c.configFile,
    VYSU_ENGINE: ENGINE,
  });
  const argv = argvFor(file, args);
  return new Promise((resolve) => {
    const child = spawn(argv.file, argv.args, { stdio: 'inherit', env, windowsVerbatimArguments: argv.verbatim });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (e) => {
      process.stderr.write(`vysu: ${file}: ${e.message}\n`);
      resolve(127);
    });
  });
}
