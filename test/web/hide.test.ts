// VYSU_WEB_HIDE: the selectors, one rule each, and the page script that hides them on every document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideJs, hideSelectors } from '../../src/web/js.ts';

test('the list is cut at its own commas only', () => {
  assert.deepEqual(hideSelectors('.tsqd-parent-container, .TanStackRouterDevtools'), ['.tsqd-parent-container', '.TanStackRouterDevtools']);
  assert.deepEqual(hideSelectors(':is(.a, .b) > c,[aria-label="x, y"], d'), [':is(.a, .b) > c', '[aria-label="x, y"]', 'd']);
  assert.deepEqual(hideSelectors(" , button[aria-label='Open, now'] ,"), ["button[aria-label='Open, now']"]);
  assert.deepEqual(hideSelectors(''), []);
});

test('one rule per selector, so a typo hides nothing less than the rest', () => {
  const js = hideJs('.tsqd-parent-container, .TanStackRouterDevtools');
  assert.ok(js.includes('.tsqd-parent-container{display:none!important}\\n.TanStackRouterDevtools{display:none!important}'));
  assert.ok(js.includes('DOMContentLoaded'));
  assert.doesNotThrow(() => new Function(js));
});

test('the script puts its stylesheet in once, even before the document element exists', () => {
  const added: Array<{ id: string; textContent: string }> = [];
  const listeners: Array<() => void> = [];
  const doc = {
    documentElement: null as unknown,
    head: null as unknown,
    getElementById: (id: string) => added.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: (_: string, f: () => void) => void listeners.push(f),
  };
  new Function('document', hideJs('.x'))(doc);
  assert.equal(added.length, 0);
  doc.documentElement = { appendChild: (s: { id: string; textContent: string }) => void added.push(s) };
  for (const f of listeners) f();
  for (const f of listeners) f();
  assert.equal(added.length, 1);
  assert.equal(added[0]!.textContent, '.x{display:none!important}');
});
