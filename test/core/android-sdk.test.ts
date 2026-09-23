// Where the Android SDK is: a settings file first (as a sourced file set it), then the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../../src/core/config.ts';

test('ANDROID_HOME from the config wins over the environment, which wins over the default', () => {
  const proj = mkdtempSync(join(tmpdir(), 'vysu-sdk-'));
  mkdirSync(join(proj, '.vysu'));
  const env = { VYSU_PROJECT_DIR: proj };
  const saved = { home: process.env.ANDROID_HOME, root: process.env.ANDROID_SDK_ROOT };
  try {
    process.env.ANDROID_HOME = '/from/env';
    delete process.env.ANDROID_SDK_ROOT;
    writeFileSync(join(proj, '.vysu', 'config'), 'ANDROID_HOME=/from/config\n');
    assert.equal(Config.load(env, proj).androidSdk, '/from/config');
    writeFileSync(join(proj, '.vysu', 'config'), 'ANDROID_SDK_ROOT=/root/from/config\n');
    assert.equal(Config.load(env, proj).androidSdk, '/from/env');
    delete process.env.ANDROID_HOME;
    assert.equal(Config.load(env, proj).androidSdk, '/root/from/config');
  } finally {
    for (const [k, v] of [['ANDROID_HOME', saved.home], ['ANDROID_SDK_ROOT', saved.root]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
