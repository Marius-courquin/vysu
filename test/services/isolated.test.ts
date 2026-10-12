import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../../src/core/config.ts';
import { formatRecord, myPorts, parsePorts, parseRecord, pointAtIsolated, resolverRule, withPort, worktreeOf } from '../../src/services/isolated.ts';

process.env.VYSU_OWNER = 'test:1';

test('isolated ports are read as ranges and lists, in order', () => {
  assert.deepEqual(parsePorts('8101-8103'), [8101, 8102, 8103]);
  assert.deepEqual(parsePorts('8101,8105 8103-8104'), [8101, 8105, 8103, 8104]);
  assert.deepEqual(parsePorts(''), []);
  assert.deepEqual(parsePorts('abc'), []);
});

test('the command line gets the isolated port where it says {port}, else where it spells the shared one', () => {
  assert.equal(withPort('vite --port {port}', '8100', '8101'), 'vite --port 8101');
  assert.equal(withPort('pnpm --filter web exec vite --port 8100 --strictPort', '8100', '8102'), 'pnpm --filter web exec vite --port 8102 --strictPort');
  assert.equal(withPort('http://localhost:8100/', '8100', '8102'), 'http://localhost:8102/');
  assert.equal(withPort('serve --port 81000 v1.8100', '8100', '8102'), 'serve --port 81000 v1.8100');
  assert.equal(withPort('npm run dev', '8100', '8102'), 'npm run dev');
  assert.equal(withPort('vite --port {port}', '', '8100'), 'vite --port 8100');
});

test('a record keeps a folder with spaces', () => {
  const text = formatRecord({ port: '8101', pid: '42', owner: 'claude:1', dir: '/a b/c' });
  assert.deepEqual(parseRecord('web', text), { service: 'web', port: '8101', pid: '42', owner: 'claude:1', dir: '/a b/c' });
  assert.equal(parseRecord('web', ''), null);
});

test('this owner\'s browser maps the shared origin onto its isolated port, other owners do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-iso-'));
  mkdirSync(join(dir, '.vysu'));
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, '.vysu', 'config'), `VYSU_STATE='${dir}/state'\nVYSU_SERVICES='web api'\nVYSU_SERVICE_web_PORT=8100\nVYSU_BROWSER_ARGS='--lang=fr'\n`);
  const load = (): Config => Config.load({ ...process.env, VYSU_OWNER: 'test:1' }, dir);
  assert.deepEqual(myPorts(load()), []);
  assert.equal(pointAtIsolated(load()), '');
  writeFileSync(join(dir, 'state', 'service-port.web.test-1'), formatRecord({ port: '8101', pid: '7', owner: 'test:1', dir: '/w' }));
  writeFileSync(join(dir, 'state', 'service-port.web.other-2'), formatRecord({ port: '8102', pid: '8', owner: 'other:2', dir: '/o' }));
  const c = load();
  assert.deepEqual(myPorts(c), [{ service: 'web', shared: '8100', port: '8101', dir: '/w' }]);
  assert.equal(pointAtIsolated(c), resolverRule('8100', '8101'));
  assert.equal(c.get('BROWSER_ARGS'), '--lang=fr\n--host-resolver-rules=MAP localhost:8100 localhost:8101');
  assert.equal(c.get('ORIGIN'), '');
});

test('the service folder is found again in the worktree the command runs from', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vysu-wt-')));
  const repo = join(root, 'app');
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  const git = (cwd: string, ...a: string[]): void => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'apps', 'web', 'index.html'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'worktree', 'add', '-q', join(root, 'wt'), '-b', 'feat');
  assert.equal(worktreeOf(join(repo, 'apps', 'web'), join(root, 'wt', 'apps')), join(root, 'wt', 'apps', 'web'));
  assert.equal(worktreeOf(repo, join(root, 'wt')), join(root, 'wt'));
  assert.equal(worktreeOf(join(repo, 'apps', 'web'), repo), join(repo, 'apps', 'web'));
  assert.equal(worktreeOf(repo, root), null);
});
