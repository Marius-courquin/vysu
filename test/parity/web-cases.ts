// The cases of the web parity run (test/parity/web.ts): `node test/parity/web-cases.ts [--only …]`.
// `-` and `lotweb` are sessions nobody else uses for these pages; `tb_resident` is a Nidz persona
// already logged in on the local web and on prep, read from and never logged in here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main, scratch, type Case } from './web.ts';

// Never the project's own state: `cache clear` empties whatever state folder it is pointed at.
const cacheState = join(scratch, 'cache-state');
const cacheFiles = (): void => {
  mkdirSync(cacheState, { recursive: true });
  for (const f of ['ios-udid-iphone-17-pro', 'android-serial-pixel', 'scale-ios-x', 'state-ios-x.env', 'state-', 'keep-me', '.state-hidden']) {
    writeFileSync(join(cacheState, f), 'x');
  }
};

const PUBLIC = 'https://example.com/';
const LOCAL = 'http://localhost:8100';
const PREP = 'https://next.prep.nidz.fr';
const HOME: string[][] = [['lotweb', 'open', PUBLIC], ['lang', 'lotweb', 'en']];

const usage: Case[] = [
  ['shots'], ['shots', '-'], ['walk', '-'], ['walk', '-', 'n'], ['flow'], ['flow', '-'], ['rec', '-'], ['rec', '-', 'n'],
  ['lang'], ['lang', '-'], ['check'], ['box'], ['box', '-'], ['login'], ['mlogin'], ['mlogin', 'ios'], ['auth'],
  ['auth', 'token'], ['auth', 'test'], ['auth', 'bogus'], ['token'], ['prune', '--bogus'], ['cache'], ['cache', 'x'],
  ['shots', '-', 'n', '--bogus'], ['shots', '-', 'n', '--baseline', 'a', '--baseline-url', 'b'],
  ['shots', '-', 'n', '--baseline', 'no-such-folder'], ['shots', '-', 'n', '--baseline-url', '@'],
  ['shots', '-', 'n', '--url', PUBLIC, '--lang', 'de'], ['flow', '-', 'no-such-file'], ['flow', '-', '-', '--bogus'],
  ['rec', '-', 'n', '--bogus'], ['rec', '-', 'n'], ['rec', '-', 'n', '--'], ['prune', '--match', '*'],
  ['prune', '--match', 'a/b'], ['lang', '-', 'de'],
].map((args) => ({ name: `usage/${args.join(' ') || '(none)'}`, args }));

const cases: Case[] = [
  ...usage,
  { name: 'pass/get-url', args: ['lotweb', 'open', PUBLIC] },
  { name: 'pass/title', args: ['lotweb', 'get', 'title'] },
  { name: 'pass/fail', args: ['lotweb', 'find', 'role', 'button', 'click', '--name', 'Nope'] },
  { name: 'pass/anon', args: ['-', 'get', 'url'] },
  { name: 'pass/stdin-batch', args: ['lotweb', 'batch', '--json'], stdin: '[["get","title"]]', ignore: [/"lifecycle"/] },
  { name: 'check/plain', args: ['check', 'lotweb'] },
  { name: 'check/save', args: ['check', 'lotweb', '--save', 'chk'], shots: 'chk', files: ['check.txt'] },
  { name: 'box/css', args: ['box', 'lotweb', 'h1'] },
  { name: 'box/page', args: ['box', 'lotweb', 'h1', '--page'] },
  { name: 'box/none', args: ['box', 'lotweb', '#nothing-here'] },
  { name: 'lang/set', args: ['lang', 'lotweb', 'en'] },
  {
    name: 'shots/plain',
    args: ['shots', 'lotweb', 's1', '--url', PUBLIC, '--sizes', '360x800,1440x900'],
    shots: 's1',
    files: ['meta.json'],
    images: ['360x800.png', '1440x900.png'],
  },
  {
    name: 'shots/full-dark',
    args: ['shots', 'lotweb', 's2', '--url', PUBLIC, '--sizes', '768x1024', '--full', '--dark', '--freeze'],
    shots: 's2',
    files: ['meta.json'],
    images: ['768x1024.png', '768x1024-dark.png'],
  },
  {
    name: 'shots/baseline-url',
    args: ['shots', 'lotweb', 's3', '--url', PUBLIC, '--sizes', '360x800,1280x800', '--baseline-url', 'https://example.com/', '--ignore', 'h1', '--ignore', 'p'],
    shots: 's3',
    files: ['meta.json', 'diff.txt'],
    images: ['360x800.png', '360x800-base.png', '1280x800.png'],
  },
  {
    name: 'shots/no-url',
    args: ['shots', 'lotweb', 's4', '--sizes', '1440x900', '--lang', 'en'],
    shots: 's4',
    files: ['meta.json'],
  },
  {
    name: 'shots/vs-folder',
    args: ['shots', 'lotweb', 's5', '--url', PUBLIC, '--sizes', '360x800,1440x900,1024x768', '--baseline', 's1'],
    shots: 's5',
    files: ['meta.json', 'diff.txt'],
  },
  {
    name: 'shots/lang-ignore-full',
    args: ['shots', 'lotweb', 's6', '--url', PUBLIC, '--sizes', '360x800', '--lang', 'fr', '--full', '--no-warm', '--ignore', 'p', '--dark'],
    shots: 's6',
    files: ['meta.json'],
    images: ['360x800.png', '360x800-dark.png'],
  },
  { name: 'shots/no-lang-key', args: ['lang', 'lotweb', 'en'], env: { VYSU_LANG_STORAGE_KEY: '' } },
  { name: 'shots/bad-browser', args: ['lotweb', 'get', 'url'], env: { VYSU_BROWSER_PATH: '/nonexistent/chrome' } },
  {
    name: 'walk/public',
    args: ['walk', 'lotweb', 'w1', '--url', PUBLIC, '--sizes', '360x800,1440x900', '--baseline-url', PUBLIC, '--check'],
    shots: 'w1',
    files: ['meta.json', 'diff.txt', 'check.txt'],
  },
  {
    name: 'walk/vs-folder',
    args: ['walk', 'lotweb', 'w2', '--url', PUBLIC, '--sizes', '360x800', '--baseline', 'w1'],
    shots: 'w2',
    files: ['meta.json', 'diff.txt', 'check.txt'],
  },
  {
    name: 'flow/public',
    args: ['flow', 'lotweb', '-', '--shots', 'f1', '--viewport', '1280x800'],
    setup: HOME,
    stdin: `# a comment\ngo ${PUBLIC}\nshot home\n\nclick "Learn more"\nshot after --full\nget title\nviewport 800x600\nsleep 0.2\ncheck\n`,
    shots: 'f1',
    files: ['meta.json', 'check.txt'],
    images: ['web-home.png', 'web-after.png'],
  },
  {
    name: 'flow/fail',
    args: ['flow', 'lotweb', '-'],
    stdin: `go ${PUBLIC}\nclick "No such thing"\nshot never\n`,
  },
  {
    name: 'flow/go-fail',
    args: ['flow', 'lotweb', '-'],
    stdin: 'go https://no-such-host.invalid/\nshot never\n',
  },
  {
    name: 'flow/bad-shot-option',
    args: ['flow', 'lotweb', '-', '--shots', 'f2'],
    stdin: `go ${PUBLIC}\nshot x --wide\n`,
  },
  {
    name: 'flow/i18n-no-locales',
    args: ['flow', 'lotweb', '-'],
    stdin: 'click t:common.close\n',
    env: { VYSU_LOCALES: '' },
  },
  {
    name: 'flow/shot-no-shots',
    args: ['flow', 'lotweb', '-'],
    stdin: 'shot x\n',
  },
  {
    name: 'rec/public',
    args: ['rec', 'lotweb', 'r1', '--fps', '10', '--viewport', '800x600', '--', `go ${PUBLIC}`, 'sleep 0.5', 'click "Learn more"', 'sleep 0.5', 'click "Nothing"'],
    setup: HOME,
    shots: 'r1',
    files: ['meta.json', 'events.json'],
    // The clip is as long as the steps took, and the steps are what got faster.
    ignore: [/^events\.json: /, /^\d+ frames @/, /^f\d+–f\d+: /, /^dumped \d+ frames/, /"(start|end|t0|duration)":/],
  },
  // A persona of the project, already logged in: the local web read against prep.
  // The same page twice, a few seconds apart: the feed moves between the two on either engine.
  {
    name: 'nidz/walk-prep',
    args: ['walk', 'tb_resident', 'nw', '--url', `${PREP}/community/news`, '--sizes', '1440x900,360x800', '--baseline-url', '@', '--full'],
    shots: 'nw',
    files: ['meta.json'],
    ignore: [/: changed /, /^ {2}\S+ \d+\. x /, /^read: /, /^identical, do not read: /],
  },
  {
    name: 'nidz/shots-prep-lang',
    args: ['shots', 'tb_resident', 'np', '--url', `${PREP}/community/news`, '--sizes', '768x1024', '--lang', 'fr'],
    shots: 'np',
    files: ['meta.json'],
  },
  {
    name: 'nidz/auth0-test',
    args: ['auth', 'test', 'tb_resident'],
    env: { VYSU_ORIGIN: PREP },
    ignore: [/^step: auth token \(\d+ characters\) ok$/],
  },
  {
    name: 'nidz/walk-local',
    args: ['walk', 'tb_resident', 'nl', '--url', `${LOCAL}/community/news`, '--sizes', '1280x800', '--baseline-url', '@'],
    shots: 'nl',
    files: ['meta.json'],
  },
  {
    name: 'nidz/flow-i18n',
    args: ['flow', 'tb_resident', '-', '--shots', 'nf'],
    stdin: `go ${PREP}/community/news\nclick t:common.close\n`,
  },
  { name: 'nidz/token-length', args: ['auth', 'token', 'tb_resident'], ignore: [/^eyJ/] },
  { name: 'nidz/describe', args: ['auth', 'describe'] },
  { name: 'nidz/token-alias', args: ['token', 'tb_resident'], ignore: [/^eyJ/] },
  { name: 'cache/clear', args: ['cache', 'clear'], env: { VYSU_STATE: cacheState }, prepare: cacheFiles },
  { name: 'cache/empty', args: ['cache', 'clear'], env: { VYSU_STATE: join(scratch, 'no-such-state') } },
  { name: 'prune/dry', args: ['prune', '--dry-run', '--days', '30'], env: { VYSU_SHOTS: `${process.env.HOME}/.nidz/visual/shots` } },
  { name: 'prune/dry-match', args: ['prune', '--dry-run', '--match', 'rv-* tv-*'], env: { VYSU_SHOTS: `${process.env.HOME}/.nidz/visual/shots` } },
];

await main(cases);
