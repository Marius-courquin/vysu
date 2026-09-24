import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asPrinted, ceilingMs } from '../../src/mobile/agent.ts';

test('every agent-device call has a ceiling a minute past what it announces', () => {
  assert.equal(ceilingMs(['snapshot', '-i']), 120000);
  assert.equal(ceilingMs(['wait', 'text', 'Bienvenue', '8000']), 120000);
  assert.equal(ceilingMs(['open', 'Nidz (prep)', '--timeout', '180000']), 240000);
  assert.equal(ceilingMs(['press', '305', '45']), 120000);
});

test('a snapshot from the library reads as the CLI prints it: long labels repeated from an ancestor left out', () => {
  const title = "Un logo pour le panneau de l'entrée ?";
  const data = {
    nodes: [
      { index: 0, type: 'Application', label: 'Nidz (prep)' },
      { index: 1, parentIndex: 0, type: 'ScrollView', label: title },
      { index: 2, parentIndex: 1, type: 'Other' },
      { index: 3, parentIndex: 2, type: 'Button', label: title, identifier: 'card' },
      { index: 4, parentIndex: 1, type: 'Other', label: 'Actualités' },
      { index: 5, parentIndex: 4, type: 'Other', label: 'Actualités' },
    ],
    truncated: false,
  };
  const out = asPrinted(data) as { nodes: Array<Record<string, unknown>>; truncated: boolean };
  assert.equal(out.truncated, false);
  assert.deepEqual(out.nodes[3], { index: 3, parentIndex: 2, type: 'Button', identifier: 'card', inheritsLabel: true });
  assert.equal(out.nodes[1]!.label, title);
  // Under 24 characters a repeat stays, as the CLI keeps it.
  assert.equal(out.nodes[5]!.label, 'Actualités');
  assert.equal(asPrinted({ nodes: [] }).nodes.length, 0);
});
