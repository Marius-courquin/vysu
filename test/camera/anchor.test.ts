import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pyJson } from '../../src/img/fmt.ts';
import { anchorOnReactions, reactionOffset, readRows, shiftRows } from '../../src/img/take.ts';

// A motion report as motion writes it: its header, then one line per run of moving frames.
function motion(onsets: number[], frames = 1200): string {
  const f = (o: number): string => String(Math.round(o * 60)).padStart(5, '0');
  return `${frames} frames @ 60 fps (20.0 s)\n\n## timeline (frames that move)\n${onsets.map((o) => `f${f(o)}–f${f(o + 2 / 60)}: 33 ms, up to 3 % of the picture\n`).join('')}`;
}

const T = [1.0, 3.7, 6.5, 9.2, 12.0];
const plus = (d: number) => (t: number): number => t + d;

// The expected offsets are what take.py's anchor_on_reactions answered on the same reports.
test('the offset that puts a reaction after the most touches, when it is clear', () => {
  assert.equal(reactionOffset(motion(T.map(plus(1.63))), T), 0.74);
  assert.equal(reactionOffset(motion(T.map(plus(0.4))), T), 0);
  assert.equal(reactionOffset(motion([T[0]! + 1.63, T[1]! + 1.63, T[2]! + 1.63, T[3]! + 5, T[4]! + 7]), T), 1.3);
  const far = [1.0, 6.0, 11.0, 16.0];
  assert.equal(reactionOffset(motion(far.map(plus(-0.6))), far), -0.62);
});

test('no shift when it is not clear: too few agree, or barely more than unshifted', () => {
  assert.equal(reactionOffset(motion([T[0]! + 1.63, T[1]! + 1.63]), T), 0);
  assert.equal(reactionOffset(motion([...T.slice(0, 4).map(plus(0.4)), T[4]! + 1.63]), T), 0);
  assert.equal(reactionOffset('no header\nf00010–f00012: 33 ms\n', T), 0);
  assert.equal(reactionOffset('1200 frames @ 60 fps (20.0 s)\n\n(still)\n', T), 0);
});

test('only taps with a touch count, three at least, and a motion report must be there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-anchor-'));
  try {
    const rows = (verb: string, n: number): string =>
      T.slice(0, n)
        .map((t, i) => `${i + 1}\t${1000 + t - 0.5}\t${1000 + t + 0.5}\ttrue\t\t\t${verb} "x"\t${1000 + t - 0.15}`)
        .join('\n');
    const read = (verb: string, n: number) => readRows(rows(verb, n), 1000, 'mobile', 'ios');
    assert.equal(anchorOnReactions(dir, read('tap', 5)), 0);
    writeFileSync(join(dir, 'motion.txt'), motion(T.map(plus(1.63))));
    assert.equal(anchorOnReactions(dir, read('tap', 5)), 0.74);
    assert.equal(anchorOnReactions(dir, read('fill', 5)), 0);
    assert.equal(anchorOnReactions(dir, read('tap', 2)), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shift moves start, end and touch of every step, rounded as Python rounds', () => {
  const rows = readRows('1\t1003.3\t1004.1\ttrue\t\t\ttap "a"\t1003.4\n2\t1004.2\t1005.2\ttrue\t\t\tsleep 1', 1000, 'mobile', 'ios');
  shiftRows(rows, -2.1);
  assert.equal(
    pyJson(rows.map((r) => r.step)),
    '[{"i": 1, "line": "tap \\"a\\"", "verb": "tap", "label": "a", "start": 1.2, "end": 2.0, "at": 1.45, "ok": true}, ' +
      '{"i": 2, "line": "sleep 1", "verb": "sleep", "start": 2.1, "end": 3.1, "ok": true}]',
  );
});
