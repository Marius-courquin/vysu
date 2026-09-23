// `vysu __prim <primitive> …`: one primitive of the auth connector contract, for a bash connector
// run through the bridge (src/auth/bridge.ts). Internal: the bridge is its only caller, and its
// locks are held for the vysu that started the bridge.
import { parseBoxes, webClickAny } from '../auth/context.ts';
import { die } from '../core/errors.ts';
import type { Platform } from '../core/hold.ts';
import { personaRequire, personaVar } from '../core/personas.ts';
import { shellQuote } from '../core/shellenv.ts';
import * as mobile from '../mobile/api.ts';
import { passthrough } from '../web/passthrough.ts';

const platform = (p: string | undefined): Platform => {
  if (p !== 'ios' && p !== 'android') die('platform must be ios or android');
  return p;
};
const status = (ok: boolean): number => (ok ? 0 : 1);

export async function run(args: string[]): Promise<number> {
  const [name, a = '', ...rest] = args;
  const out = (s: string): void => void process.stdout.write(s);
  switch (name) {
    case 'web':
      return passthrough(a, rest);
    case 'web_click_any':
      return status(await webClickAny(a, rest));
    case 'mob': {
      const r = await mobile.mob(platform(a), rest);
      out(r.stdout);
      process.stderr.write(r.stderr);
      return r.code;
    }
    case 'mob_press_if':
      return status(await mobile.mobPressIf(platform(a), rest[0] ?? ''));
    case 'mob_press_any':
      return status(await mobile.mobPressAny(platform(a), rest[0] ?? ''));
    // 1 when none of them was there, as 0.5.1 answered: a connector may branch on it.
    case 'mob_press_all':
      return status(await mobile.mobPressAll(platform(a), rest[0] ?? ''));
    case 'mob_wait_text':
      return status(await mobile.mobWaitText(platform(a), rest[0] ?? '', Number(rest[1] || 8000)));
    // No field is `[]` and 1, still JSON for a connector that parses before it tests the status.
    case 'mob_fields': {
      const json = await mobile.mobFields(platform(a));
      const found = parseBoxes(json).length > 0;
      out(`${found ? json.replace(/\n$/, '') : '[]'}\n`);
      return status(found);
    }
    case 'mobile_app':
      out(mobile.mobileApp(platform(a)));
      return 0;
    case 'mobile_load_bundle':
      await mobile.mobileLoadBundle(platform(a));
      return 0;
    case 'mobile_prepare':
      await mobile.mobilePrepare(platform(a));
      return 0;
    case 'mstate_set':
      mobile.mstateSet(platform(a), rest[0] ?? '', rest[1] ?? '');
      return 0;
    // Two assignments the bridge evaluates: a password crosses a pipe to its own shell, never a
    // command line, a file or a terminal.
    case 'persona_require': {
      const { email, password } = personaRequire(a);
      out(`PERSONA_EMAIL=${shellQuote(email)}; PERSONA_PASSWORD=${shellQuote(password)}\n`);
      return 0;
    }
    case 'persona_var':
      out(personaVar(a, rest[0] ?? ''));
      return 0;
    default:
      die(`vysu __prim: no primitive « ${name ?? ''} »`);
  }
}
