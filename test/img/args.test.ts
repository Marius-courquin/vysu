import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, type ParserSpec } from '../../src/img/args.ts';

const spec: ParserSpec = {
  prog: 'x',
  usage: 'usage: x src',
  pos: [{ name: 'src' }],
  opts: { '--title': { kind: 'str' }, '--ignore': { kind: 'append' }, '--preset': { kind: 'str' } },
};

function parse(argv: string[]): unknown {
  const err: string[] = [];
  const r = parseArgs(spec, argv, { out: () => undefined, err: (s) => err.push(s) });
  return typeof r === 'number' ? err.join('').split('\n').at(-2) : r;
}

test('an option with = is an option, whatever its value holds', () => {
  const want = { title: 'Nouvelle annonce', ignore: [], preset: 'pitch', src: 'shot.png' };
  assert.deepEqual(parse(['shot.png', '--preset', 'pitch', '--title=Nouvelle annonce']), want);
  assert.deepEqual(parse(['shot.png', '--preset', 'pitch', '--tit=Nouvelle annonce']), want);
  assert.deepEqual(parse(['shot.png', '--title', 'Nouvelle annonce', '--preset=pitch']), want);
  assert.deepEqual(parse(['--ignore=-5,0,10,10', 'shot.png']), { title: null, ignore: ['-5,0,10,10'], preset: null, src: 'shot.png' });
  // What argparse does too: a value that looks like an option needs the = form.
  assert.equal(parse(['shot.png', '--ignore', '-5,0,10,10']), 'x: error: argument --ignore: expected one argument');
  assert.deepEqual(parse(['shot.png', '--title', '-1']), { title: '-1', ignore: [], preset: null, src: 'shot.png' });
  assert.deepEqual(parse(['shot.png', '--title', '-a b']), { title: '-a b', ignore: [], preset: null, src: 'shot.png' });
  assert.equal(parse(['shot.png', '--nope=a b']), 'x: error: unrecognized arguments: --nope=a b');
});
