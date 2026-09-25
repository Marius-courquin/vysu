// `vysu doctor`: what is resolved and what is missing — the engine and its tools, the values in force
// and where each came from, the connectors, the personas, the shots, the devices, the locks and the
// browser sessions. Read-only: it installs nothing and drives nothing.
//
// The slow answers (the two drivers, ffmpeg, the size of the shots, the devices and sessions the web
// and mobile code report) are all asked at once at the start, and printed in their place.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { die, VysuError } from '../core/errors.ts';
import { locksReport } from '../core/hold.ts';
import { isWindows, which } from '../core/host.ts';
import { personaNames } from '../core/personas.ts';
import { run as spawnRun, runTool } from '../core/proc.ts';
import { noColor, ok, warn } from '../core/ui.ts';
import { mobileDoctorLines, pushDescribeLines } from '../mobile/api.ts';
import { authDescribeLine, webDoctorLines } from '../web/api.ts';
import { checkerFamily, checkerModel } from '../setup/checker.ts';
import { engineDepsCheck, engineSha, engineVersion, ffmpegReport, ffmpegVersion, nodeCheck, toolsCheck, versionWarn } from '../setup/engine.ts';
import { skillsLine } from '../setup/skills.ts';

// The values in force, and where each comes from: a surprise in a report is nearly always a key set
// in an environment nobody remembers exporting.
const KEYS = (
  'STATE ORIGIN LOGIN_PATH BASELINE_ORIGIN BROWSER_PATH BROWSER_ARGS SIZES LANGS LANG LANG_STORAGE_KEY LOCALES ' +
  'WEB_REPO API_PATTERN API_HOSTS AUTH MOBILE_KIND MOBILE_HEADLESS MOBILE_BUNDLE IOS_APP MOBILE_DIR ' +
  'MOBILE_ENV MOBILE_SCHEME MOBILE_READY_TEXT IOS_APP_PATH ANDROID_APK MOBILE_BUILD_IOS ' +
  'MOBILE_BUILD_ANDROID MOBILE_DEEPLINK MOBILE_DISMISS_LABELS METRO_PORT MLOG_IGNORE IOS_DEVICES ' +
  'ANDROID_LOCALE SERVICES PUSH THEME MIN_VERSION'
).split(' ');

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

// A promise started early must not reject before anyone listens: it is settled, and read later.
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// A section the web or mobile code could not answer (an error it did not foresee) says so in one
// line and the doctor goes on; a die ends the doctor.
function linesOf(section: string, r: Settled<string[] | string>): string[] {
  if (r.ok) return typeof r.value === 'string' ? [r.value] : r.value;
  if (r.error instanceof VysuError) throw r.error;
  const msg = r.error instanceof Error ? r.error.message : String(r.error);
  return [`${section}: (unavailable — ${msg})`];
}

const listNames = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
};

// What `du -sh` says of a folder. Where there is no du, the same figure from the files themselves:
// their blocks on disk, in powers of 1024, one decimal below ten.
async function diskUsage(dir: string): Promise<string> {
  if (!existsSync(dir)) return '';
  if (!isWindows && which('du')) {
    const r = await spawnRun('du', ['-sh', dir]);
    return r.code === 0 || r.stdout ? (r.stdout.split('\t')[0] ?? '').trim() : '';
  }
  return humanSize(treeBytes(dir));
}

function treeBytes(dir: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    total += st.blocks ? st.blocks * 512 : st.size;
    if (!st.isDirectory()) return;
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) walk(join(p, n));
  };
  walk(dir);
  return total;
}

export function humanSize(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${v}B`;
  return v < 10 ? `${v.toFixed(1)}${units[i]}` : `${Math.round(v)}${units[i]}`;
}

export async function run(args: string[]): Promise<void> {
  for (const a of args) {
    if (a === '--no-color') noColor();
    else die(`vysu doctor: unknown option ${a}`, 'vysu doctor');
  }
  const c = config();
  const sha = engineSha();
  const ffmpeg = ffmpegVersion();
  const shotsSize = diskUsage(c.shots);
  // `agent-browser doctor` would answer this too, but it launches a browser to do it: the help page is
  // the same yes-or-no for a tenth of the time.
  const record = which('agent-browser') ? runTool('agent-browser', ['record', '--help']) : Promise.resolve({ code: 1 });
  const mobile = settle(mobileDoctorLines());
  const web = settle(webDoctorLines());

  versionWarn();
  const out = (line: string): boolean => process.stdout.write(`${line}\n`);
  out(`vysu ${engineVersion()} (${await sha}) — ${ENGINE}`);
  out(`project: ${c.get('PROJECT')}${c.projectDir ? ` · ${c.projectDir}` : ''}${c.configFile ? ` · ${c.configFile}` : ''}`);
  if (!c.configFile) warn('config: none found — anonymous web captures only', 'vysu init');
  await toolsCheck('report');
  await nodeCheck();
  engineDepsCheck();
  // Which browser a capture will actually render in: the engine's headless Chrome for Testing, or the
  // one this machine chose. A diff against a baseline captured elsewhere depends on it.
  const exe = c.get('BROWSER_PATH');
  ok(`browser: ${exe ? `${basename(exe)} · ${exe} (${c.origin('BROWSER_PATH')})` : 'Chrome for Testing (agent-browser default, headless)'}`);
  const version = engineVersion();
  skillsLine(version);
  for (const key of KEYS) {
    const value = c.get(key);
    if (!value) continue;
    // A project with no mobile app has no mobile kind either: the default reads « native », which says
    // nothing true about it.
    if (key === 'MOBILE_KIND' && !c.get('MOBILE_BUNDLE')) continue;
    out(`  VYSU_${key} = ${value} (${c.origin(key)})`);
  }
  if (c.get('AUTH') === 'none' && c.origin('AUTH') === 'default') out('auth: none (default)');
  else for (const l of linesOf('auth', await settle(authDescribeLine()))) out(l);
  if (!c.get('PUSH')) out('push: (none — VYSU_PUSH is not set)');
  else for (const l of linesOf('push', await settle(pushDescribeLines()))) out(l);
  const family = checkerFamily();
  const models = c.get('CHECKER_MODELS');
  out(`checker: model for ${family}: ${checkerModel(family) || 'inherited'}${models ? ` (VYSU_CHECKER_MODELS = ${models})` : ''}`);
  if (existsSync(c.personas)) out(`personas (${c.personas}): ${personaNames().map((n) => `${n} `).join('')}`);
  else out(`personas: MISSING (${c.personas})`);
  out(`shots: ${c.shots} (${listNames(c.shots).length} folders, ${await shotsSize})`);
  ffmpegReport(await ffmpeg);
  // Where the `t:<key>` labels of a flow are looked up: a folder the config names, relative to the
  // project, that a flow finds missing only when it needs a label.
  const locales = c.locales;
  if (locales) out(`locales: ${existsSync(locales) && statSync(locales).isDirectory() ? 'ok' : `MISSING (${locales})`}`);
  const rec = (await record).code === 0 ? `ok${which('ffmpeg') ? '' : ' (ffmpeg MISSING)'}` : 'MISSING (agent-browser >= 0.38)';
  out(`remotion: node_modules ${existsSync(join(c.remotion, 'node_modules')) ? 'ok' : 'MISSING (installed on the first vysu video)'}`);
  out(`demo: agent-browser record ${rec}`);
  // An empty cache is an answer, not a failure.
  const cached = listNames(c.state).filter((n) => /^(ios-udid-|android-serial-|scale-|state-)/.test(n));
  out(`cache: ${cached.length ? `${cached.map((n) => `${n} `).join('')} — vysu cache clear` : '(empty)'}`);
  // The devices, what each was left in, then who holds what: the mobile code's lines, with the AVDs
  // the machine offers after the locks, where they always were.
  const deviceLines = linesOf('devices', await mobile);
  const later = deviceLines.filter((l) => l.startsWith('avds:'));
  for (const l of deviceLines) if (!l.startsWith('avds:')) out(l);
  for (const l of await locksReport()) out(l);
  for (const l of later) out(l);
  for (const l of linesOf('sessions', await web)) out(l);
}
