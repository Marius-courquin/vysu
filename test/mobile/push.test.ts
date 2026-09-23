// Push presets, the JSON the drivers send and print, and the fcm assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { fillPreset } from '../../src/push/push.ts';
import { pyJson, pyPrint } from '../../src/push/pyjson.ts';
import { fcmJwt } from '../../src/connectors/push/fcm.ts';
import { fetchFailure, shownUrl, withoutCredentials } from '../../src/push/http.ts';
import { createServer } from 'node:http';

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

// curl sent a url's credentials as Basic auth; fetch refuses to build the request at all, and its
// « fetch failed » said nothing: the drivers answered « unreachable » to both.
test('a push url with credentials: Basic auth, never shown, and the cause of a failure', async () => {
  assert.deepEqual(withoutCredentials('https://h.example/x'), { url: 'https://h.example/x', headers: {} });
  assert.deepEqual(withoutCredentials('https://bot:t%40k@h.example/send?a=1', { 'Content-Type': 'application/json' }), {
    url: 'https://h.example/send?a=1',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from('bot:t@k').toString('base64')}` },
  });
  assert.deepEqual(withoutCredentials('https://tok@h.example/', { authorization: 'Bearer b' }), { url: 'https://h.example/', headers: { authorization: 'Bearer b' } });
  assert.equal(shownUrl('https://bot:secret@h.example:8443/send?a=1'), 'https://***@h.example:8443/send?a=1');
  assert.equal(shownUrl('http://localhost:8080/push'), 'http://localhost:8080/push');

  let auth = '';
  const server = createServer((q, s) => {
    auth = q.headers.authorization ?? '';
    s.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const t = withoutCredentials(`http://bot:tok@127.0.0.1:${port}/`);
  assert.equal((await fetch(t.url, { method: 'POST', headers: t.headers, body: '{}' })).status, 200);
  assert.equal(auth, `Basic ${Buffer.from('bot:tok').toString('base64')}`);
  await new Promise((r) => server.close(r));
  // The port just freed: nothing listens there any more.
  const refused = await fetch(`http://127.0.0.1:${port}/`).then(() => '', fetchFailure);
  assert.match(refused, /ECONNREFUSED/);
  assert.match(await fetch('https://bot:tok@h.example/').then(() => '', fetchFailure), /includes credentials/);
  assert.equal(fetchFailure(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error(''), { code: 'ECONNREFUSED', errors: [new Error('connect ECONNREFUSED ::1:1'), new Error('connect ECONNREFUSED 127.0.0.1:1')] }) })), 'connect ECONNREFUSED ::1:1, connect ECONNREFUSED 127.0.0.1:1');
  assert.equal(fetchFailure(Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' } })), 'CERT_HAS_EXPIRED: certificate has expired');
});
