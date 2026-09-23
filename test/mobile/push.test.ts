// Push presets, the JSON the drivers send and print, and the fcm assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../../src/core/config.ts';
import { setConfig } from '../../src/core/ctx.ts';
import { driverEnv, fillPreset } from '../../src/push/push.ts';
import { pyJson, pyPrint } from '../../src/push/pyjson.ts';
import { fcmJwt } from '../../src/connectors/push/fcm.ts';

test('preset placeholders filled from --field, the missing ones named once, sorted', () => {
  const text = '{"title": "{{ title }}", "id": "{{ticketId}}", "again": "{{title}}", "x": "{{z}}{{a}}{{z}}"}';
  const r = fillPreset(text, ['title=Lift out of order', 'ticketId=42', 'noequals']);
  assert.equal(r.out, '{"title": "Lift out of order", "id": "42", "again": "Lift out of order", "x": "{{z}}{{a}}{{z}}"}');
  assert.deepEqual(r.missing, ['a', 'z']);
  assert.equal(fillPreset('{"v": "{{k}}"}', ['k=a=b']).out, '{"v": "a=b"}');
});

test('json.dumps as Python writes it', () => {
  assert.equal(pyJson({ a: 'é', b: 'x"y', c: 'tab\t', d: '😀' }), '{"a": "\\u00e9", "b": "x\\"y", "c": "tab\\t", "d": "\\ud83d\\ude00"}');
  assert.equal(pyJson({ results: [{ platform: 'ios' }], x: [1, 2] }, false), '{"results": [{"platform": "ios"}], "x": [1, 2]}');
  assert.equal(pyJson({}), '{}');
  assert.equal([pyPrint(null), pyPrint(true), pyPrint('ok'), pyPrint(3)].join(' '), 'None True ok 3');
});

test('the fcm assertion is an RS256 JWT the account key verifies', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwt = fcmJwt(pem, 'sa@proj.iam.gserviceaccount.com', 'https://oauth2.googleapis.com/token', 'scope-x', 1000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(c!, 'base64url').toString()), {
    iss: 'sa@proj.iam.gserviceaccount.com',
    scope: 'scope-x',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1000,
    exp: 4600,
  });
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s!, 'base64url')));
});

// The driver's `ad ios push …` is a vysu of its own: the config's device in its environment would
// win there over the one this owner claimed.
test('a bash driver gets the device only when this command was given it in the environment', () => {
  const proj = mkdtempSync(join(tmpdir(), 'vysu-push-env-'));
  mkdirSync(join(proj, '.vysu'));
  writeFileSync(join(proj, '.vysu', 'config'), "VYSU_IOS_DEVICE='iPhone 17 Pro'\nVYSU_ANDROID_AVD=pixel_cfg\n");
  const base = { VYSU_PROJECT_DIR: proj, VYSU_STATE: join(proj, 'state') };
  setConfig(Config.load(base, proj));
  let e = driverEnv();
  assert.equal(e.VYSU_IOS_DEVICE, undefined);
  assert.equal(e.VYSU_ANDROID_AVD, undefined);
  assert.equal(e.VYSU_CONFIG_FILE, join(proj, '.vysu', 'config'));
  setConfig(Config.load({ ...base, VYSU_IOS_DEVICE: 'iPhone SE' }, proj));
  e = driverEnv();
  assert.equal(e.VYSU_IOS_DEVICE, 'iPhone SE');
  assert.equal(e.VYSU_ANDROID_AVD, undefined);
});
