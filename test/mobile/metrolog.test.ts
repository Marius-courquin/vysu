import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../../src/core/config.ts';
import { setConfig } from '../../src/core/ctx.ts';
import { metroLog } from '../../src/mobile/metro.ts';

function load(lines: string[], extra: Record<string, string> = {}): Config {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vysu-metrolog-')));
  mkdirSync(join(dir, '.vysu'));
  writeFileSync(join(dir, '.vysu', 'config'), `VYSU_PROJECT='p'\nVYSU_STATE='${dir}/state'\n${lines.join('\n')}\n`);
  const c = Config.load({ HOME: process.env.HOME, PATH: process.env.PATH, VYSU_OWNER: 'test:1', ...extra }, dir);
  setConfig(c);
  return c;
}

test('the shared Metro log is vysu own one, unless VYSU_METRO_LOG names another', () => {
  let c = load([]);
  assert.equal(metroLog('8081'), join(c.logs, 'metro.log'));
  assert.equal(metroLog('8090'), join(c.logs, 'metro-8090.log'));
  // A workspace serving its own Metro: its port and its log.
  c = load(["VYSU_METRO_PORT='43976'", "VYSU_METRO_LOG='/home/me/ws/topic/metro.log'"]);
  assert.equal(metroLog('43976'), '/home/me/ws/topic/metro.log');
  assert.equal(metroLog(), '/home/me/ws/topic/metro.log');
  // Any other port is a Metro vysu runs, with vysu's log.
  assert.equal(metroLog('8082'), join(c.logs, 'metro-8082.log'));
});
