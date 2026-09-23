import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../../src/core/config.ts';
import { setConfig } from '../../src/core/ctx.ts';
import { ev, evLog, evRow, evStart, evStep, evStop, evTouch, typingHuman } from '../../src/core/rec.ts';
import { pyJson } from '../../src/img/fmt.ts';
import { readRows } from '../../src/img/take.ts';

const scratch = mkdtempSync(join(tmpdir(), 'vysu-rows-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

test('a row holds the touch as its 8th column, and nothing is touched outside a take', () => {
  evStop();
  evTouch();
  assert.equal(ev.at, '');
  const rows = join(scratch, 'events.jsonl');
  evStart(rows);
  ev.target = '350 822';
  evTouch();
  assert.match(ev.at, /^\d+\.\d{3}$/);
  const at = ev.at;
  evLog('press 350\t822\n', '1790196607.089', '1790196608.075', true);
  evStep();
  assert.deepEqual([ev.target, ev.label, ev.at], ['', '', '']);
  evLog('sleep 1.2', '1790196608.088', '1790196609.300', false);
  evStop();
  assert.equal(readFileSync(rows, 'utf8'), `1\t1790196607.089\t1790196608.075\ttrue\t350 822\t\tpress 350 822 \t${at}\n2\t1790196608.088\t1790196609.300\tfalse\t\t\tsleep 1.2\t\n`);
  assert.equal(evRow('a', '1', '2', true), `2\t1\t2\ttrue\t\t\ta\t\n`);
});

test('VYSU_TYPING: human while a take records, unless it says fast; human everywhere when it says so', () => {
  const at = (typing: string | undefined, recording: boolean): boolean => {
    setConfig(Config.load(typing === undefined ? {} : { VYSU_TYPING: typing }, scratch));
    if (recording) evStart(join(scratch, 'typing.jsonl'));
    else evStop();
    return typingHuman();
  };
  assert.equal(at(undefined, true), true);
  assert.equal(at(undefined, false), false);
  assert.equal(at('fast', true), false);
  assert.equal(at('human', false), true);
  assert.equal(at('other', true), true);
  evStop();
});

test('events: the touch lands a round trip after it was sent, an old row has none', () => {
  const rows = [
    '4\t1790196607.089\t1790196608.075\ttrue\t350 822\t\tpress 350 822\t1790196607.096',
    '5\t1790196608.088\t1790196608.372\ttrue\t\t\twait "Publier"\t',
    '6\t1790196608.4\t1790196609\tfalse\t\t\tsleep 0.5',
  ].join('\n');
  const mobile = readRows(rows, 1790196600.688, 'mobile', 'ios');
  assert.equal(
    pyJson(mobile.map((r) => r.step)),
    '[{"i": 4, "line": "press 350 822", "verb": "tap", "start": 6.4, "end": 7.39, "at": 6.56, "ok": true, "target": {"x": 350, "y": 822}}, ' +
      '{"i": 5, "line": "wait \\"Publier\\"", "verb": "other", "start": 7.4, "end": 7.68, "ok": true}, ' +
      '{"i": 6, "line": "sleep 0.5", "verb": "sleep", "start": 7.71, "end": 8.31, "ok": false}]',
  );
  assert.deepEqual(mobile[0]!.t, { start: 6.4, end: 7.39, at: 6.56 });
  assert.equal(readRows(rows, 1790196600.688, 'web', 'web')[0]!.t.at, 6.46);
});
