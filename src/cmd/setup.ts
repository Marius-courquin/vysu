// `vysu setup [--yes] [--dry-run] [--ios-device <n>] [--ios-old-device <n>] [--android-avds "<spec>;…"]
// [--browser <path|default>]`: the machine — tools, browser, simulators, emulators. Every line is
// fine, optional and missing, or required and missing; it ends on the counts and the commands to run,
// and exits 1 when something required is missing.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { HOME, IOS_DEFAULT_DEVICE } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { which } from '../core/host.ts';
import { runTool } from '../core/proc.ts';
import { allRequiredPresent, head, info, miss, noColor, ok, summary } from '../core/ui.ts';
import { browserLabel, browsersFound, isExecutable } from '../setup/browsers.ts';
import { androidSection, avdSpecs, iosProbe, iosSection } from '../setup/devices.ts';
import { engineDepsCheck, ffmpegReport, ffmpegVersion, nodeCheck, nodeVersion, toolsCheck } from '../setup/engine.ts';
import { installHint } from '../setup/hints.ts';
import { ask, interactive } from '../setup/prompt.ts';
import { pythonProbe, pythonReport } from '../setup/python.ts';

export async function run(args: string[]): Promise<number> {
  let iosDevice = '';
  let iosOld = '';
  let avds = '';
  let browser = '';
  let browserGiven = false;
  let assumeYes = false;
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string => {
      if (i + 1 >= args.length) die(`vysu setup: ${a} needs a value`, 'vysu setup --help');
      return args[++i]!;
    };
    if (a === '--ios-device') iosDevice = value();
    else if (a === '--ios-old-device') iosOld = value();
    else if (a === '--android-avds') avds = value();
    else if (a === '--browser') {
      browser = value();
      browserGiven = true;
    } else if (a === '--no-color') noColor();
    else if (a === '--yes' || a === '-y') assumeYes = true;
    else if (a === '--dry-run') dry = true;
    else die(`vysu setup: unknown option ${a}`, 'vysu setup --help');
  }
  // An agent runs setup to read the machine, not to change it: with no terminal to answer the one
  // question below, an installing run would download system images and create simulators nobody
  // asked for. Reporting is the default there, and `--yes` is how a script asks for the real thing.
  if (!dry && !assumeYes && !interactive()) {
    dry = true;
    info('no terminal, and no --yes: reporting only — nothing is installed or created');
  }
  const c = config();
  const machineEnv = join(HOME, '.vysu', 'machine.env');
  mkdirSync(join(c.state, 'shots'), { recursive: true });
  mkdirSync(c.logs, { recursive: true });
  mkdirSync(join(HOME, '.vysu'), { recursive: true });

  // The slow questions (an interpreter, the simulators) run while the quick lines are printed.
  const python = pythonProbe();
  const ffmpeg = ffmpegVersion();
  const ios = iosProbe();

  head('tools');
  await nodeCheck();
  if (await nodeVersion()) await toolsCheck(dry ? 'report' : 'install');
  else miss('agent-browser / agent-device: no node to install them on', `${installHint('node')} && npm i -g agent-browser agent-device`);
  engineDepsCheck();
  pythonReport(await python, true);
  ffmpegReport(await ffmpeg);

  head('browser');
  // The default is deliberate: agent-browser downloads Chrome for Testing and drives it headless,
  // so a capture renders the same on every machine, no personal profile is opened and no extension
  // rewrites the page. An installed browser is a choice, with that caveat attached.
  let wantBrowser = c.get('BROWSER_PATH');
  if (browser === 'default') wantBrowser = '';
  else if (browser) {
    if (!isExecutable(browser)) die(`--browser: not an executable: ${browser}`, browserListHint());
    wantBrowser = browser;
  }
  const found = browsersFound();
  if (!browserGiven && found.length && interactive() && !dry) {
    info('Chromium-based browsers on this machine:');
    process.stdout.write(found.map((p, i) => `  ${i + 1}) ${p}\n`).join(''));
    const answer = await ask('Use one instead of Chrome for Testing? [number, or Enter to keep the default] ');
    if (answer === '' || /^[nN]/.test(answer)) wantBrowser = '';
    else {
      const n = /^\d+$/.test(answer) ? Number(answer) : 0;
      wantBrowser = found[n - 1] ?? '';
      if (!wantBrowser) die(`no browser number ${answer} in that list`, 'vysu setup --browser default');
    }
  } else if (found.length) {
    info(`also installed here: ${found.map(browserLabel).join(', ')} (vysu setup --browser <path>)`);
  }
  if (wantBrowser) {
    ok(`browser: ${basename(wantBrowser)} — your own; a page may render unlike a baseline captured elsewhere`);
  } else if (existsSync(join(HOME, '.agent-browser', 'browsers'))) {
    ok('browser: Chrome for Testing, headless (same rendering everywhere)');
  } else if (dry || !which('agent-browser')) {
    miss('browser: nothing to drive — Chrome for Testing is not downloaded', 'agent-browser install');
  } else {
    info('browser: downloading Chrome for Testing…');
    if ((await runTool('agent-browser', ['install'])).code === 0) ok('browser: Chrome for Testing, headless (same rendering everywhere)');
    else miss('browser: the download failed', 'agent-browser install');
  }

  head('devices');
  // Named before anything is created, and changeable: a machine that already has the simulators it
  // wants must not grow three more because vysu has its own idea of them.
  let wantIos = iosDevice || c.get('IOS_DEVICE', IOS_DEFAULT_DEVICE);
  let wantOld = iosOld || c.get('IOS_OLD_DEVICE');
  let wantAvds = avds || c.get('ANDROID_AVDS');
  info(`ios (recent): ${wantIos}`);
  info(`ios (old):    ${wantOld}`);
  for (const spec of avdSpecs(wantAvds)) info(`avd:          ${spec.name} (api ${spec.api})`);
  if (!iosDevice && !iosOld && !avds && interactive()) {
    const keep = await ask('Keep these? [Y/n] ');
    if (/^[nN]/.test(keep)) {
      wantIos = (await ask(`recent iPhone [${wantIos}]: `)) || wantIos;
      wantOld = (await ask(`old iPhone [${wantOld}]: `)) || wantOld;
      wantAvds = (await ask(`AVD specs [${wantAvds}]: `)) || wantAvds;
    }
  }
  // Below the project config in precedence: a machine says what it has, a project says what it wants.
  if (dry) {
    info(`machine.env: ${machineEnv} (unchanged — reporting only)`);
  } else {
    const lines = [
      '# written by vysu setup — what this machine drives.',
      `VYSU_IOS_DEVICE='${wantIos}'`,
      `VYSU_IOS_OLD_DEVICE='${wantOld}'`,
      `VYSU_ANDROID_AVDS='${wantAvds}'`,
    ];
    if (wantBrowser) lines.push(`VYSU_BROWSER_PATH='${wantBrowser}'`);
    writeFileSync(machineEnv, `${lines.join('\n')}\n`);
    ok(`machine.env: ${machineEnv}`);
    if (existsSync(join(HOME, '.vysu', 'devices.env'))) {
      info('devices.env: still read, and below machine.env — delete it once you have moved its keys over');
    }
  }

  head('ios');
  await iosSection(await ios, wantOld, dry);

  head('android');
  await androidSection(wantAvds, dry);

  summary(['cd <your project> && vysu init      the .vysu/config of that project', 'vysu persona add <name>             credentials, mode 600, never printed']);
  return allRequiredPresent() ? 0 : 1;
}

// Where the installed browsers are, for the reader who has to find one to name.
function browserListHint(): string {
  if (process.platform === 'darwin') return 'ls /Applications';
  if (process.platform === 'win32') return 'dir "%ProgramFiles%"';
  return 'which google-chrome chromium brave-browser microsoft-edge';
}
