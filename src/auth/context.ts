// The primitives an auth connector is given, and nothing else: the web ones drive the persona's own
// browser session, the mobile ones the chosen device, each under its lock.
import { config } from '../core/ctx.ts';
import { die, exit, log } from '../core/errors.ts';
import type { Platform } from '../core/hold.ts';
import { personaRequire, personaVar } from '../core/personas.ts';
import { commaList, sleep } from '../core/text.ts';
import * as mobile from '../mobile/api.ts';
import { ab, evalValue, lastLine } from '../web/ab.ts';
import type { AuthContext, Box } from './types.ts';

// Silent outside `vysu auth test`, so a login prints the one line it always printed and a test
// reads as the list of what held.
let steps = false;
export function stepsOn(on: boolean): void {
  steps = on;
}
export const stepsAreOn = (): boolean => steps;

export async function webClickAny(persona: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (!name) continue;
    if ((await ab(persona, ['find', 'role', 'button', 'click', '--name', name], { stderr: 'drop' })).code === 0) return true;
  }
  return false;
}

export function parseBoxes(json: string): Box[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as Box[]) : [];
  } catch {
    return [];
  }
}

export function context(): AuthContext {
  return {
    async web(persona, ...args) {
      const r = await ab(persona, args);
      if (r.code !== 0) exit(r.code);
      return r.stdout;
    },
    webTry: (persona, ...args) => ab(persona, args, { stderr: 'drop' }),
    webClickAny: (persona, ...names) => webClickAny(persona, names),
    async mob(platform, ...args) {
      const r = await mobile.mob(platform, args);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.code !== 0) exit(r.code);
      return r.stdout;
    },
    mobTry: (platform, ...args) => mobile.mob(platform, args),
    mobPressIf: (platform, label) => mobile.mobPressIf(platform, label),
    mobPressAny: (platform, labels) => mobile.mobPressAny(platform, labels),
    mobPressAll: async (platform, labels) => void (await mobile.mobPressAll(platform, labels)),
    mobWaitText: (platform, text, ms = 8000) => mobile.mobWaitText(platform, text, ms),
    mobFields: async (platform: Platform) => parseBoxes(await mobile.mobFields(platform)),
    mobileApp: (platform) => mobile.mobileApp(platform),
    mobileRelaunch: (platform) => mobile.mobileRelaunch(platform),
    mobileLoadBundle: (platform) => mobile.mobileLoadBundle(platform),
    mobilePrepare: (platform) => mobile.mobilePrepare(platform),
    mobileUnblock: (platform) => mobile.mobileUnblock(platform),
    mobileReset: (platform) => mobile.mobileReset(platform),
    mstateSet: (platform, key, value) => mobile.mstateSet(platform, key, value),
    personaRequire: (persona) => personaRequire(persona),
    personaVar: (persona, key) => personaVar(persona, key),
    cfg: (key, fallback = '') => config().get(key, fallback),
    labels: (list) => commaList(list),
    die: (message, next) => die(message, next),
    log: (message) => log(message),
    step(what) {
      if (steps) process.stdout.write(`step: ${what} ok\n`);
    },
    sleep: (seconds) => sleep(seconds * 1000),
    lastLine: (text) => lastLine(text),
    value: (text) => evalValue(text),
  };
}
