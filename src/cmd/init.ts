// `vysu init [--yes] [--skills-dir <dir>] [--agents-dir <dir>]`: a project's `.vysu/config`, written
// from the template with the answers substituted, then the agent skills and the checker definition.
// `vysu init --refresh-skills`: the skills again, and nothing else.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { info, noColor } from '../core/ui.ts';
import { checkerAgentInstall } from '../setup/checker.ts';
import { ask } from '../setup/prompt.ts';
import { projectRoot, skillsInstall, skillsInstalledVersion, skillsTarget } from '../setup/skills.ts';

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The template is the documentation: it is copied whole, and only the answers are substituted, so
// every key a project may ever want is in front of whoever opens the file next. An answer left empty
// stays commented out: the key is documented, not set.
export function fillTemplate(template: string, answers: Record<string, string>): string {
  const lines = template.replaceAll('\r\n', '\n').split(/(?<=\n)/);
  return lines
    .map((line) => {
      const m = /^#?\s*(VYSU_[A-Z0-9_]+)=/.exec(line);
      if (!m || !(m[1]! in answers)) return line;
      const value = answers[m[1]!]!;
      // A quote in an answer is closed and reopened, so the line still reads back as typed.
      const quoted = value.includes("'") ? `'${value.replaceAll("'", `'"'"'`)}'` : `'${value}'`;
      return `${value ? '' : '# '}${m[1]}=${quoted}\n`;
    })
    .join('');
}

export async function run(args: string[]): Promise<void> {
  let yes = false;
  let skillsDir = '';
  let agentsDir = '';
  let refresh = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--skills-dir' && i + 1 < args.length) skillsDir = args[++i]!;
    else if (a === '--agents-dir' && i + 1 < args.length) agentsDir = args[++i]!;
    else if (a === '--refresh-skills') refresh = true;
    else if (a === '--no-color') noColor();
    else die(`vysu init: unknown option ${a}`, 'vysu --help');
  }
  // An engine update brings new skills; the copies in a project do not follow on their own.
  // `--refresh-skills` re-copies them and touches nothing else — not the config, not the personas.
  if (refresh) {
    const target = skillsDir || skillsTarget();
    skillsInstall(target);
    if (!skillsInstalledVersion(target)) die('init --refresh-skills: this engine ships no skill to install', 'vysu update');
    // The agent definition follows the skills it points at, where one was installed before.
    const agents = agentsDir || join(projectRoot(), '.claude', 'agents');
    if (agentsDir || isFile(join(agents, 'visual-checker.md'))) checkerAgentInstall(agents);
    return;
  }

  const here = ((): string => {
    try {
      return realpathSync(process.cwd());
    } catch {
      return process.cwd();
    }
  })();
  let root = projectRoot();
  // A `.vysu` found above is another project's: init is about the folder it was run in.
  if (!isFile(join(root, '.vysu', 'config'))) root = here;
  const template = join(ENGINE, 'templates', 'config.example');
  if (!isFile(template)) die(`init: ${template} missing`);
  if (isFile(join(root, '.vysu', 'config'))) die(`init: ${root}/.vysu/config already exists (edit it, or delete it first)`);

  // Interactive with a default, or the default under --yes.
  const question = async (prompt: string, def: string): Promise<string> => {
    if (yes) return def;
    return (await ask(`${prompt} [${def}]: `)) || def;
  };
  if (!yes) info('Enter keeps the value in brackets; every answer can be changed later in .vysu/config');
  const project = await question('project name (session prefix and state folder)', basename(root));
  const origin = await question('web origin — where the app runs locally', 'http://localhost:3000');
  const loginPath = await question(
    'login path — the page on that origin where a user signs in (/ if the home page has the login; anything if there is no login)',
    '/login',
  );
  const baseline = await question('baseline origin — the deployed main, that a branch is diffed against (empty for none)', '');
  const auth = await question('auth connector — auth0 | form (an e-mail + password form on the login page) | token (a token the persona holds, no login page) | none (no login) | custom', 'none');
  const mobile = await question('mobile app — none | expo (Metro dev-client) | native (Swift, Kotlin, Flutter…)', 'none');
  let kind = '';
  let bundle = '';
  let iosApp = '';
  let mobileDir = '';
  let iosAppPath = '';
  let androidApk = '';
  if (/^[eEyY]/.test(mobile)) {
    kind = 'expo';
    bundle = await question('mobile bundle id', '');
    iosApp = await question('app name on the iOS simulator', '');
    mobileDir = await question('Expo app folder, relative to the project', 'apps/mobile');
  } else if (/^[nN][aA]/.test(mobile)) {
    kind = 'native';
    bundle = await question('mobile bundle id', '');
    iosApp = await question('app name on the iOS simulator', '');
    // Both may be left empty: a device that already has the app needs neither, and the build
    // commands (VYSU_MOBILE_BUILD_IOS / _ANDROID) are documented in the config they are written to.
    iosAppPath = await question('the .app built for iphonesimulator, relative to the project (empty: none)', '');
    androidApk = await question('the debug .apk, relative to the project (empty: none)', '');
  }
  const push = await question('push drivers (apns-sim,webhook,fcm — empty for none)', '');
  const drivers = `,${push},`;
  const webhook = drivers.includes(',webhook,') ? await question('webhook url', '') : '';

  const vysu = join(root, '.vysu');
  for (const d of ['push', 'commands', 'themes']) mkdirSync(join(vysu, d), { recursive: true });
  const text = fillTemplate(readFileSync(template, 'utf8'), {
    VYSU_PROJECT: project,
    VYSU_ORIGIN: origin,
    VYSU_LOGIN_PATH: loginPath,
    VYSU_BASELINE_ORIGIN: baseline,
    VYSU_AUTH: auth,
    VYSU_MOBILE_BUNDLE: bundle,
    VYSU_IOS_APP: iosApp,
    VYSU_MOBILE_DIR: mobileDir,
    VYSU_MOBILE_KIND: kind,
    VYSU_IOS_APP_PATH: iosAppPath,
    VYSU_ANDROID_APK: androidApk,
    VYSU_PUSH: push,
    VYSU_PUSH_WEBHOOK_URL: webhook,
  });
  writeFileSync(join(vysu, 'config'), text);
  console.log(`wrote ${root}/.vysu/config`);
  if (!readdirSync(join(vysu, 'push')).some((n) => !n.startsWith('.'))) {
    writeFileSync(join(vysu, 'push', 'example.json'), '{\n "title": "{{title}}",\n "body": "{{body}}"\n}\n');
    console.log(`wrote ${root}/.vysu/push/example.json`);
  }
  if (!isFile(join(vysu, 'commands', 'README'))) {
    writeFileSync(
      join(vysu, 'commands', 'README'),
      'Executables here become vysu commands: `vysu <name>` runs ./<name> with every VYSU_* exported,\nVYSU_ENGINE set to the engine dir and VYSU_PROJECT_DIR to this project.\n',
    );
  }
  // The answer decides, unless the environment names a connector for this very command. The
  // template is the module form, which runs wherever vysu runs; a connector the project already
  // has, in any form, is left alone (the first found is the one loaded).
  const connector = config().origin('AUTH') === 'env' ? config().get('AUTH') : auth;
  if (connector === 'custom' && !['auth.mjs', 'auth.js', 'auth.ts', 'auth.sh'].some((f) => isFile(join(vysu, f)))) {
    const example = join(ENGINE, 'connectors', 'auth', 'example.mjs');
    if (isFile(example)) {
      copyFileSync(example, join(vysu, 'auth.mjs'));
      console.log(`wrote ${root}/.vysu/auth.mjs (from connectors/auth/example.mjs)`);
    }
  }

  // The skills, where an agent will find them. They may not exist yet in a given engine version:
  // whatever `skill/` holds is copied, and nothing is said when it holds nothing.
  const claude = isDir(join(root, '.claude'));
  if (skillsDir || claude) skillsInstall(skillsDir || join(root, '.claude', 'skills'));
  // The checker sub-agent, for the agent tools that read a definition file (Claude Code).
  if (agentsDir || claude) checkerAgentInstall(agentsDir || join(root, '.claude', 'agents'));
  const snippet = join(ENGINE, 'templates', 'agents-snippet.md');
  const out: string[] = [];
  if (isFile(snippet)) {
    out.push('', '--- paste this into AGENTS.md / CLAUDE.md ---');
    out.push(readFileSync(snippet, 'utf8').replace(/\n$/, ''));
    out.push('--- end ---');
  }
  out.push('', '## what only you can do now');
  out.push('vysu persona add <name>             credentials, mode 600');
  out.push('vysu login <name>                   the browser session, once');
  if (kind === 'expo') out.push('vysu up ios --build                 the native dev-client (5-20 min)');
  if (kind === 'native') out.push('VYSU_IOS_APP_PATH / VYSU_ANDROID_APK  the built app, or VYSU_MOBILE_BUILD_IOS / _ANDROID');
  if (drivers.includes(',fcm,')) out.push(`VYSU_FCM_SA                         the service account, under ${config().state}`);
  process.stdout.write(`${out.join('\n')}\n`);
}
