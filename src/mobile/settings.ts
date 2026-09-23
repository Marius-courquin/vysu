// The two system settings a screen is checked under besides the defaults: the text size and the
// appearance. Both take effect on launch, which is why `mrelaunch` applies them itself.
import { die } from '../core/errors.ts';
import type { Platform } from '../core/hold.ts';
import { adbShell, androidSdkLevel, androidSelect, sim } from './device.ts';
import { lastLine, say } from './io.ts';
import { mstateSet } from './state.ts';

async function simUi(args: string[]): Promise<void> {
  const r = await sim('ui', args);
  if (r.code !== 0) die(`ios: simctl ui ${args.join(' ')}: ${lastLine(r.out) || `exit ${r.code}`}`);
}

// Text size as the elderly set it: « large » is the biggest non-accessibility step, « xl » the
// extended range (iOS AX XXXL, Android 2.0 — 1.3 is the ceiling before Android 14).
export async function textsize(p: string, size = 'normal'): Promise<void> {
  if (p === 'android') await androidSelect();
  switch (`${p}:${size}`) {
    case 'ios:normal':
      await simUi(['content_size', 'large']);
      break;
    case 'ios:large':
      await simUi(['content_size', 'extra-extra-extra-large']);
      break;
    case 'ios:xl':
      await simUi(['content_size', 'accessibility-extra-extra-extra-large']);
      break;
    case 'android:normal':
      await adbShell(['settings', 'put', 'system', 'font_scale', '1.0']);
      await adbShell(['wm', 'density', 'reset']);
      break;
    case 'android:large':
      await adbShell(['settings', 'put', 'system', 'font_scale', '1.3']);
      break;
    case 'android:xl':
      if ((await androidSdkLevel()) >= 34) await adbShell(['settings', 'put', 'system', 'font_scale', '2.0']);
      else {
        await adbShell(['settings', 'put', 'system', 'font_scale', '1.3']);
        const d = Number(/\d+/.exec(await adbShell(['wm', 'density']))?.[0] ?? 0);
        await adbShell(['wm', 'density', String(Math.floor((d * 12) / 10))]);
      }
      break;
    default:
      die('usage: vysu textsize ios|android normal|large|xl');
  }
  mstateSet(p as Platform, 'textsize', size);
  say(`${p}: text size ${size} (takes effect on launch: vysu mrelaunch ${p}, or vysu mrelaunch ${p} --textsize ${size} in one go)`);
}

export async function appearance(p: string, mode = 'light'): Promise<void> {
  if (p === 'android') await androidSelect();
  switch (`${p}:${mode}`) {
    case 'ios:light':
    case 'ios:dark':
      await simUi(['appearance', mode]);
      break;
    case 'android:light':
      await adbShell(['cmd', 'uimode', 'night', 'no']);
      break;
    case 'android:dark':
      await adbShell(['cmd', 'uimode', 'night', 'yes']);
      break;
    default:
      die('usage: vysu appearance ios|android light|dark');
  }
  mstateSet(p as Platform, 'appearance', mode);
  say(`${p}: appearance ${mode}`);
}
