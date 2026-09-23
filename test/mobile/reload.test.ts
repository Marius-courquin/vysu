// `vysu mreload`'s pure parts: which inspector page is this device's, what a CDP message says about a
// reload, and when the wait gives up for a relaunch instead of spending the whole budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pagePick,
  RELOAD_BUDGET_MS,
  RELOAD_BUNDLE_MS,
  RELOAD_ID,
  RELOAD_START_MS,
  reloadSeenMessage,
  reloadSeenNew,
  reloadVerdict,
  RUNTIME_ID,
  type ReloadSeen,
} from '../../src/mobile/metro.ts';

const APP = 'fr.nidz.app.next.prep';
// Two devices on one Metro, as /json/list gave them on 2026-09-24 (trimmed).
const LIST = [
  {
    id: '9849acf0-1',
    title: 'fr.nidz.app.next.prep (Nidz iPhone SE (iOS 18))',
    description: 'React Native Bridgeless [C++ connection]',
    appId: APP,
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=9849acf0&page=1',
    deviceName: 'Nidz iPhone SE (iOS 18)',
  },
  {
    id: '13b4ee1a-1',
    title: 'fr.nidz.app.next.prep (Google sdk_gphone_arm64)',
    description: 'React Native Bridgeless [C++ connection]',
    appId: APP,
    webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?device=13b4ee1a&page=1',
    deviceName: 'sdk_gphone_arm64 - 11 - API 30',
  },
];

test('pagePick: the one page of this app on this device, on 127.0.0.1', () => {
  assert.equal(pagePick(LIST, APP, 'sdk_gphone_arm64 - 11 - API 30'), 'ws://127.0.0.1:8081/inspector/debug?device=13b4ee1a&page=1');
  assert.equal(pagePick(LIST, APP, 'Nidz iPhone SE (iOS 18)'), 'ws://127.0.0.1:8081/inspector/debug?device=9849acf0&page=1');
});

test('pagePick: none, another app, two of a name, no socket, or no list is no page', () => {
  assert.equal(pagePick(LIST, APP, 'iPhone 17 Pro'), '');
  assert.equal(pagePick(LIST, 'com.other', 'Nidz iPhone SE (iOS 18)'), '');
  // Two emulators of one image read the same: which one is ours cannot be told.
  const twins = [LIST[1], { ...LIST[1], id: 'ffff-1', webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?device=ffff&page=1' }];
  assert.equal(pagePick(twins, APP, 'sdk_gphone_arm64 - 11 - API 30'), '');
  assert.equal(pagePick([{ ...LIST[0], webSocketDebuggerUrl: undefined }], APP, 'Nidz iPhone SE (iOS 18)'), '');
  assert.equal(pagePick({ error: 'x' }, APP, 'Nidz iPhone SE (iOS 18)'), '');
  assert.equal(pagePick([null, 3, LIST[0]], APP, 'Nidz iPhone SE (iOS 18)'), 'ws://127.0.0.1:8081/inspector/debug?device=9849acf0&page=1');
});

const msg = (o: Record<string, unknown>): string => JSON.stringify(o);

// The messages of a real reload on the API 30 emulator, in their order.
test('reloadSeenMessage: the old context announced by Runtime.enable is not the reload', () => {
  const s = reloadSeenNew(1000);
  reloadSeenMessage(s, msg({ method: 'Runtime.executionContextCreated', params: { context: { id: 1 } } }), 1050);
  reloadSeenMessage(s, msg({ id: RUNTIME_ID, result: {} }), 1060);
  assert.equal(s.runtime, true);
  assert.equal(s.created, 0);
  s.sentAt = 1100;
  reloadSeenMessage(s, msg({ id: RELOAD_ID, result: {} }), 1110);
  reloadSeenMessage(s, msg({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 1 } }), 1112);
  reloadSeenMessage(s, msg({ method: 'Runtime.executionContextsCleared' }), 1113);
  reloadSeenMessage(s, msg({ method: 'Network.requestWillBeSent', params: { request: { headers: { Authorization: 'Bearer x' } } } }), 1500);
  reloadSeenMessage(s, msg({ method: 'Runtime.executionContextCreated', params: { context: { id: 2 } } }), 2100);
  assert.deepEqual({ acked: s.acked, started: s.started, created: s.created, refused: s.refused }, { acked: 1110, started: 1112, created: 2100, refused: false });
  // Not JSON, or an error for either request.
  reloadSeenMessage(s, 'not json', 2200);
  const r = reloadSeenNew(0);
  reloadSeenMessage(r, msg({ id: RUNTIME_ID, error: { code: -32601, message: 'Unsupported method' } }), 10);
  reloadSeenMessage(r, msg({ id: RELOAD_ID, error: { code: -32000 } }), 20);
  assert.equal(r.runtime, false);
  assert.equal(r.refused, true);
});

// A page that reports its contexts, the reload sent at t0 + 100 ms.
const page = (o: Partial<ReloadSeen> = {}): ReloadSeen => ({ ...reloadSeenNew(0), runtime: true, sentAt: 100, ...o });

test('reloadVerdict: this device reloading and Metro serving its platform is a landed reload', () => {
  assert.deepEqual(reloadVerdict(page({ acked: 110, started: 112 }), 1300, true), { kind: 'landed' });
  // Metro's line alone may be another device's: the page has to have started.
  assert.deepEqual(reloadVerdict(page({ acked: 110 }), 1300, true), { kind: 'wait' });
  // A new context is no bundle (iOS creates it before fetching one).
  assert.deepEqual(reloadVerdict(page({ acked: 110, started: 112, created: 150 }), 400, false), { kind: 'wait' });
});

test('reloadVerdict: a reload the app never starts gives up at the start budget, not after 60 s', () => {
  const acked = page({ acked: 110 });
  assert.deepEqual(reloadVerdict(acked, RELOAD_START_MS - 1, false), { kind: 'wait' });
  assert.deepEqual(reloadVerdict(acked, RELOAD_START_MS, false), { kind: 'fallback', why: 'the page took the reload but the app never started it' });
  // No answer at all is the refusal it always was.
  assert.deepEqual(reloadVerdict(page(), RELOAD_START_MS, false), { kind: 'fallback', why: 'the inspector page refused the reload' });
});

test('reloadVerdict: a reload that starts and fetches no bundle gives up at the bundle budget', () => {
  const s = page({ acked: 110, started: 120 });
  assert.deepEqual(reloadVerdict(s, 120 + RELOAD_BUNDLE_MS - 1, false), { kind: 'wait' });
  assert.deepEqual(reloadVerdict(s, 120 + RELOAD_BUNDLE_MS, false), { kind: 'fallback', why: `no new bundle ${RELOAD_BUNDLE_MS / 1000}s after the reload started` });
});

test('reloadVerdict: a refusal, a socket that never sent, and an app gone mid-reload end the wait at once', () => {
  assert.deepEqual(reloadVerdict(page({ refused: true }), 200, false), { kind: 'fallback', why: 'the inspector page refused the reload' });
  assert.deepEqual(reloadVerdict({ ...reloadSeenNew(0), closed: 50 }, 60, false), { kind: 'fallback', why: 'the inspector page refused the reload' });
  // The proxy closes the debugger with « [CONNECTION_LOST] » 0.15 s after the app is killed.
  assert.deepEqual(reloadVerdict(page({ acked: 110, started: 112, closed: 400 }), 450, false), {
    kind: 'fallback',
    why: 'the app left Metro during the reload (it closed or crashed)',
  });
  // Bundled before it went: landed, and waitReady says what became of the app.
  assert.deepEqual(reloadVerdict(page({ acked: 110, started: 112, closed: 900 }), 950, true), { kind: 'landed' });
});

test('reloadVerdict: a page with no Runtime domain has Metro and the old budget', () => {
  const legacy = page({ runtime: false, acked: 110 });
  assert.deepEqual(reloadVerdict(legacy, 3000, true), { kind: 'landed' });
  assert.deepEqual(reloadVerdict(legacy, RELOAD_BUDGET_MS - 1, false), { kind: 'wait' });
  assert.deepEqual(reloadVerdict(legacy, RELOAD_BUDGET_MS, false), { kind: 'fallback', why: `no bundle ${RELOAD_BUDGET_MS / 1000}s after the reload` });
  // Unanswered: still a refusal after the start budget.
  assert.deepEqual(reloadVerdict(page({ runtime: null }), RELOAD_START_MS, false), { kind: 'fallback', why: 'the inspector page refused the reload' });
});
