import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShellEnv, shellQuote, ShellUnsupported } from '../src/core/shellenv.ts';
import { slug } from '../src/core/text.ts';
import { fnmatch, htmlEscape, pyRound } from '../src/core/py.ts';

const parse = (text: string, env: Record<string, string> = {}): Record<string, string> =>
  Object.fromEntries(parseShellEnv(text, (n) => env[n], '/home/me').map((a) => [a.key, a.value]));

test('config lines the way bash reads them', () => {
  const got = parse(
    [
      "# a comment",
      "VYSU_PROJECT='nidz'",
      'VYSU_STATE="$HOME/.nidz/visual"',
      "VYSU_AUTH0_AFTER_LOGIN_LABELS='Entrer directement,Retour à l'\"'\"'accueil'",
      'export VYSU_X=plain # trailing comment',
      'A=1 B=${A}2; C=${MISSING:-fallback} D=${A:+set}',
      'E=~/x F=a\\ b G="a \\"q\\" \\$HOME"',
      "VYSU_MLOG_IGNORE='\\[boot |i18next is made possible'",
      'H=',
    ].join('\n'),
    { HOME: '/Users/me' },
  );
  assert.deepEqual(got, {
    VYSU_PROJECT: 'nidz',
    VYSU_STATE: '/Users/me/.nidz/visual',
    VYSU_AUTH0_AFTER_LOGIN_LABELS: "Entrer directement,Retour à l'accueil",
    VYSU_X: 'plain',
    A: '1',
    B: '12',
    C: 'fallback',
    D: 'set',
    E: '/home/me/x',
    F: 'a b',
    G: 'a "q" $HOME',
    VYSU_MLOG_IGNORE: '\\[boot |i18next is made possible',
    H: '',
  });
});

test('what only a shell can run is refused with its line', () => {
  assert.throws(() => parse('A=1\nB=$(date)\n'), (e: unknown) => e instanceof ShellUnsupported && e.line === 2);
  assert.throws(() => parse('if true; then A=1; fi'), ShellUnsupported);
  assert.throws(() => parse('A=`date`'), ShellUnsupported);
});

test('a value written back reads the same', () => {
  for (const v of ["it's", 'a"b', 'p$ss w0rd', '']) assert.equal(parse(`K=${shellQuote(v)}`).K, v);
});

test('slug is the bash one', () => {
  assert.equal(slug('iPhone SE (iOS 18)'), 'iphone-se-ios-18-');
  assert.equal(slug('Nidz iPhone 17 Pro B'), 'nidz-iphone-17-pro-b');
  assert.equal(slug('claude:41234'), 'claude-41234');
  assert.equal(slug('Élan'), '-lan');
});

test('python behaviours', () => {
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(0.1234, 3), 0.123);
  assert.ok(fnmatch('ios-home.prev.png', '*.prev.png'));
  assert.ok(fnmatch('android-home-2.png', 'android-home*'));
  assert.ok(!fnmatch('Android-home.png', 'android-*'));
  assert.ok(fnmatch('a1.png', 'a[0-9].png'));
  assert.ok(!fnmatch('ab.png', 'a[!b].png'));
  assert.equal(htmlEscape(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;');
});
