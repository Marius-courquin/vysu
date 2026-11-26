import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, subtreeFiles } from '../../src/core/config.ts';
import { absUrl, onOrigin } from '../../src/web/ab.ts';
import { sameOrigin } from '../../src/web/slots.ts';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
  return { ...out, ...extra };
};

// A checkout with a worktree under it that serves the app at an address of its own.
function project(): { dir: string; tree: string; deep: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vysu-subtree-')));
  mkdirSync(join(dir, '.vysu'));
  writeFileSync(join(dir, '.vysu', 'config'), "VYSU_PROJECT='p'\nVYSU_ORIGIN='http://localhost:8100'\nVYSU_LOGIN_PATH='/auth/login'\n");
  const tree = join(dir, 'apps', 'web', '.worktrees', 'topic');
  const deep = join(tree, 'src', 'screens');
  mkdirSync(deep, { recursive: true });
  return { dir, tree, deep };
}

test('a .vysu.env sets the values of everything under its folder, above the project config', () => {
  const { dir, tree, deep } = project();
  assert.equal(Config.load(env(), deep).get('ORIGIN'), 'http://localhost:8100');
  writeFileSync(join(tree, '.vysu.env'), "VYSU_ORIGIN='https://topic--me.dev.example.com'\n");
  const c = Config.load(env(), deep);
  assert.equal(c.get('ORIGIN'), 'https://topic--me.dev.example.com');
  assert.equal(c.origin('ORIGIN'), '.vysu.env');
  // Only what it names: the rest is the project's.
  assert.equal(c.get('LOGIN_PATH'), '/auth/login');
  assert.equal(c.projectDir, dir);
  // Outside that folder, the project's value.
  assert.equal(Config.load(env(), join(dir, 'apps')).get('ORIGIN'), 'http://localhost:8100');
  // The environment still wins.
  assert.equal(Config.load(env({ VYSU_ORIGIN: 'http://x' }), deep).get('ORIGIN'), 'http://x');
});

test('the closest .vysu.env wins, and none outside the project is read', () => {
  const { dir, tree, deep } = project();
  writeFileSync(join(dir, 'apps', '.vysu.env'), "VYSU_ORIGIN='http://far'\nVYSU_LANG='en'\n");
  writeFileSync(join(tree, '.vysu.env'), "VYSU_ORIGIN='http://near'\n");
  const c = Config.load(env(), deep);
  assert.equal(c.get('ORIGIN'), 'http://near');
  assert.equal(c.get('LANG'), 'en');
  assert.deepEqual(subtreeFiles(deep, dir), [join(dir, 'apps', '.vysu.env'), join(tree, '.vysu.env')]);
  assert.deepEqual(subtreeFiles(tmpdir(), dir), []);
  assert.deepEqual(subtreeFiles(deep, ''), []);
});

test('a path opens on VYSU_ORIGIN, whatever page the session shows', () => {
  const origin = 'https://topic--me.dev.example.com/';
  assert.deepEqual(onOrigin(['open', '/community/news'], origin), ['open', 'https://topic--me.dev.example.com/community/news']);
  assert.deepEqual(onOrigin(['open', 'https://other.example.com/a'], origin), ['open', 'https://other.example.com/a']);
  assert.deepEqual(onOrigin(['open', '//cdn.example.com/a'], origin), ['open', '//cdn.example.com/a']);
  assert.deepEqual(onOrigin(['click', '/x'], origin), ['click', '/x']);
  assert.equal(absUrl('/a', ''), '/a');
  assert.equal(absUrl('/a?b=1#c', 'http://localhost:8100'), 'http://localhost:8100/a?b=1#c');
});

test('a login is looked for on the origin of the app', () => {
  assert.equal(sameOrigin('https://a--me.dev.example.com/community/news', 'https://a--me.dev.example.com'), true);
  assert.equal(sameOrigin('https://b--me.dev.example.com/x', 'https://a--me.dev.example.com'), false);
  assert.equal(sameOrigin('about:blank', 'https://a--me.dev.example.com'), false);
  assert.equal(sameOrigin('chrome-error://chromewebdata/', 'http://localhost:8100'), false);
  assert.equal(sameOrigin('', 'http://localhost:8100'), false);
});
