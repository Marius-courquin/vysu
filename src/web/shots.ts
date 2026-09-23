// `vysu shots`: one capture per viewport, all of them queued into one agent-browser batch, then each
// diffed against a baseline folder or the same page on the baseline origin.
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { langCheck } from '../core/i18n.ts';
import { metaWrite, repoBranch, repoSha } from '../core/meta.ts';
import { tool } from '../img/tools.ts';
import { bboxes, bcmd, brun, lastResult } from './ab.ts';
import { ignoreJs, langReadJs, pyJsonList } from './js.ts';
import { bchrome, bexpand, bopen, bsettle, bunexpand, bwarm, webApi } from './page.ts';

export const SHOTS_USAGE =
  'usage: vysu shots <persona> <name> [--url <url>] [--sizes WxH,…] [--dark] [--full] [--no-expand] [--no-warm] [--freeze] [--lang <l>] [--ignore <css>]… [--baseline <name> | --baseline-url <url>]';

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// An option's value, or the end of the command: a flag given last with nothing after it.
export function optValue(args: string[], i: number, cmd: string): string {
  if (i + 1 >= args.length) die(`vysu ${cmd}: ${args[i]} needs a value`);
  return args[i + 1]!;
}

// `${size%x*}` and `${size#*x}`.
export function wh(size: string): [string, string] {
  const last = size.lastIndexOf('x');
  const first = size.indexOf('x');
  return [last < 0 ? size : size.slice(0, last), first < 0 ? size : size.slice(first + 1)];
}

// diff's --ignore for the boxes a selector resolved to, one `--ignore=<box>` each: a box starting left
// of the page (-5,0,…) read as an option otherwise, and diff's exit 2 ended the whole command.
export const ignoreArgs = (boxes: string): string[] => boxes.split(' ').filter(Boolean).map((b) => `--ignore=${b}`);

export async function shots(persona: string, name: string, args: string[], print: (s: string) => void): Promise<void> {
  const c = config();
  let url = '';
  let sizes = c.get('SIZES');
  let dark = false;
  let full = false;
  let baseline = '';
  let baseurl = '';
  let lang = '';
  let freeze = false;
  let expand = true;
  let warm = true;
  const ignore: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--url':
        url = optValue(args, i++, 'shots');
        break;
      case '--sizes':
        sizes = optValue(args, i++, 'shots');
        break;
      case '--dark':
        dark = true;
        break;
      case '--full':
        full = true;
        break;
      case '--no-expand':
        expand = false;
        break;
      case '--no-warm':
        warm = false;
        break;
      case '--freeze':
        freeze = true;
        break;
      case '--lang':
        lang = optValue(args, i++, 'shots');
        break;
      case '--ignore':
        ignore.push(optValue(args, i++, 'shots'));
        break;
      case '--baseline':
        baseline = optValue(args, i++, 'shots');
        break;
      case '--baseline-url':
        baseurl = optValue(args, i++, 'shots');
        break;
      default:
        die(`vysu shots: unknown option ${a}`);
    }
  }
  if (baseline && baseurl) die('vysu shots: --baseline and --baseline-url are exclusive');
  if (baseline && !isDir(join(c.shots, baseline))) die(`no baseline folder ${join(c.shots, baseline)}`);
  if (baseurl && !url) die('vysu shots: --baseline-url needs --url (the page under test)');
  // « @ » is the shorthand for « the same path on the baseline origin »: a branch on localhost read
  // against the deployed main, without spelling the url out twice.
  if (baseurl === '@') {
    const origin = c.get('BASELINE_ORIGIN');
    if (!origin) die('vysu shots: --baseline-url @ needs VYSU_BASELINE_ORIGIN');
    baseurl = origin.replace(/\/$/, '') + url.replace(/^https?:\/\/[^/]*/, '');
  }
  langCheck(lang);
  // A page that scrolls the document already (a marketing site, a Storybook story) needs nothing
  // unfolded, and --no-expand is how a sticky section is seen where it sticks rather than at the top.
  if (!full) expand = false;
  // Nothing below the fold to reveal without --full: the capture stops at the window either way.
  if (!full) warm = false;
  const diffing = !!(baseline || baseurl);
  // A diff taken on a page that still moves reads as a change: the baseline modes freeze by themselves.
  if (diffing) freeze = true;

  const dir = join(c.shots, name);
  mkdirSync(dir, { recursive: true });
  if (diffing) writeFileSync(join(dir, 'diff.txt'), '');
  // The boxes of an --ignore selector are resolved viewport by viewport (a header is not the same
  // box at 360 and at 1440), inside the batch, and read back from its results.
  const ignJs = ignore.length ? ignoreJs(ignore.filter(Boolean), full) : '';
  const sizeList = sizes.split(/[\s,]+/).filter(Boolean);
  const shot = (file: string): void => bcmd('screenshot', ...(full ? ['--full'] : []), file);

  const schemes = dark ? ['light', 'dark'] : ['light'];
  let toOpen = !!url;
  let changed = 0;
  for (const scheme of schemes) {
    const suffix = scheme === 'dark' ? '-dark' : '';
    if (freeze) bcmd('set', 'media', scheme, 'reduced-motion');
    else bcmd('set', 'media', scheme);
    if (baseurl) {
      // Both origins in the same batch and the same session, one login serving the two, and every
      // viewport captured before switching back: a navigation is the expensive part, not a resize.
      bopen(baseurl, lang, freeze);
      for (const size of sizeList) {
        bcmd('set', 'viewport', ...wh(size));
        bsettle();
        if (expand) bexpand();
        if (warm) bwarm();
        shot(join(dir, `${size}${suffix}-base.png`));
        if (expand) bunexpand();
      }
      bopen(url, lang, freeze);
    } else if (toOpen) {
      bopen(url, lang, freeze);
      toOpen = false;
    } else {
      bchrome(freeze);
    }
    for (const size of sizeList) {
      bcmd('set', 'viewport', ...wh(size));
      bsettle();
      if (expand) bexpand();
      if (warm) bwarm();
      if (ignJs) bcmd('eval', ignJs);
      shot(join(dir, `${size}${suffix}.png`));
      if (expand) bunexpand();
    }
    const boxes = bboxes(await brun(persona));

    let idx = 0;
    for (const size of sizeList) {
      const label = `${size}${suffix}`;
      const cur = join(dir, `${label}.png`);
      const bx = boxes[idx++] ?? '';
      print(`${cur}\n`);
      if (!diffing) continue;
      const base = baseurl ? join(dir, `${label}-base.png`) : join(c.shots, baseline, `${label}.png`);
      if (!existsSync(base)) {
        print(`  (no baseline for ${label})\n`);
        continue;
      }
      const r = await tool('diff', [base, cur, '--mark', join(dir, `${label}-changed.png`), ...ignoreArgs(bx)]);
      const out = (r.stdout + r.stderr).replace(/\n+$/, '');
      if (r.code > 1) die(`diff: ${out}`);
      const lines = out.split('\n');
      print(lines.map((l) => `  ${l}\n`).join(''));
      appendFileSync(join(dir, 'diff.txt'), lines.map((l, k) => (k === 0 ? `${label}: ${l}\n` : `  ${l}\n`)).join(''));
      if (r.code !== 0) changed++;
    }
  }
  // Back to the state the next command expects, and the language the app is actually left in.
  bcmd('set', 'media', 'light');
  bcmd('set', 'viewport', '1440', '900');
  const readLang = langReadJs();
  let applied = '';
  if (readLang) {
    bcmd('eval', readLang);
    applied = lastResult(await brun(persona));
  } else {
    bboxes(await brun(persona));
  }

  const repo = c.webRepo;
  await metaWrite(dir, {
    kind: 'web',
    persona,
    url,
    baseline: baseline || 'null',
    baseline_url: baseurl || 'null',
    lang: lang || applied || c.get('LANG'),
    schemes: pyJsonList(schemes),
    sizes: pyJsonList(sizes.split(',')),
    freeze: String(freeze),
    ignore: ignore.length ? pyJsonList(ignore.filter(Boolean)) : '[]',
    full: String(full),
    expand: String(expand),
    warm: String(warm),
    web_sha: repoSha(repo),
    web_branch: repoBranch(repo),
    api: await webApi(persona),
  });

  if (diffing) {
    if (changed === 0) print('sheet: skipped (identical)\n');
    else print(`changed: ${changed} viewport(s) → vysu sheet ${name}\n`);
  }
}
