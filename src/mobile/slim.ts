// VYSU_IOS_SLIM: the simulators of the pool booted slim by simslim (github.com/MobAI-App/simslim),
// which turns off the daemons a simulator does not need (Siri, search, iCloud, News…), persistently,
// in the simulator's own launchd overrides. On a Mac mini (M5 Pro, 15 cores), three stock clones
// running a login and a flow loaded it to 495 at peak, six slim ones to 44 (2026-11-23).
// '' (the default): stock. `default`: simslim's own profile. Anything else: a simslim profile file
// (JSON, `{"except": […], "keep": […]}`), relative to the project. simslim's default profile turns off
// `apsd`, which push needs: a project that sends pushes keeps it (`"keep": ["com.apple.apsd"]`).
// Only the pool's simulators: a simulator kept for measures (a perf bench) is never slimmed by a boot.
import { statSync } from 'node:fs';
import { config } from '../core/ctx.ts';
import { which } from '../core/host.ts';
import { run } from '../core/proc.ts';
import { mstateGet, mstateSet } from './state.ts';

let warned = false;

// What a slim device was slimmed with: its UDID (a clone deleted and made again under the same name is
// stock) and the profile, with the file's time (an edited profile is applied again).
export function slimSignature(udid: string, setting: string, profileFile: string, mtimeMs: number): string {
  return setting === 'default' ? `${udid}:default` : `${udid}:${profileFile}@${Math.floor(mtimeMs)}`;
}

export function slimArgs(udid: string, setting: string, profileFile: string): string[] {
  return ['on', udid, '--preserve-boot-state', ...(setting === 'default' ? [] : ['--profile', profileFile])];
}

// Before a shut-down simulator of the pool boots: slimmed once, then left as it is. simslim boots it,
// writes the overrides and shuts it down again (5 to 15 s); the boot that follows starts slim.
export async function slimBeforeBoot(udid: string, name: string, inPool: boolean, print: (line: string) => void): Promise<void> {
  const setting = config().get('IOS_SLIM');
  if (!setting || !inPool) return;
  const bin = which('simslim');
  if (!bin) {
    if (!warned) print(`ios: VYSU_IOS_SLIM is set and simslim is not on the PATH: « ${name} » boots stock (brew install mobai-app/tap/simslim)`);
    warned = true;
    return;
  }
  let profile = '';
  let mtime = 0;
  if (setting !== 'default') {
    profile = config().projectPath(setting);
    try {
      mtime = statSync(profile).mtimeMs;
    } catch {
      print(`ios: no simslim profile ${profile} (VYSU_IOS_SLIM): « ${name} » boots stock`);
      return;
    }
  }
  const sig = slimSignature(udid, setting, profile, mtime);
  if (mstateGet('ios', 'slim') === sig) return;
  const r = await run(bin, slimArgs(udid, setting, profile), { timeoutMs: 180000 });
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n').pop() ?? '';
    print(`ios: simslim could not slim « ${name} » (${why}): it boots stock`);
    return;
  }
  mstateSet('ios', 'slim', sig);
  print(`ios: « ${name} » slimmed by simslim (${setting === 'default' ? "simslim's default profile" : setting})`);
}
