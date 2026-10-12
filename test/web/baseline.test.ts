import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineAstray } from '../../src/web/shots.ts';

test('a baseline that lands elsewhere than the page asked for is told apart from the app\'s own redirect', () => {
  const base = 'https://app.prep.nidz.fr/community';
  assert.equal(baselineAstray(base, 'https://app.prep.nidz.fr/community'), '');
  assert.equal(baselineAstray(base, 'https://app.prep.nidz.fr/community/'), '');
  // Signed out: the identity provider, or the app's public page.
  assert.equal(baselineAstray(base, 'https://auth.prep.nidz.fr/u/login?state=x'), 'lands on https://auth.prep.nidz.fr/u/login?state=x');
  assert.equal(baselineAstray(base, 'https://app.prep.nidz.fr/'), 'lands on / instead of /community');
  assert.equal(baselineAstray(base, 'https://app.prep.nidz.fr/', 'http://localhost:8100/community/news'), 'lands on / instead of /community');
  // Both sides redirect the same way: the app's own redirect, not a login.
  assert.equal(baselineAstray(base, 'https://app.prep.nidz.fr/community/news', 'http://localhost:8100/community/news'), '');
  assert.equal(baselineAstray(base, 'about:blank'), 'lands on about:blank');
});
