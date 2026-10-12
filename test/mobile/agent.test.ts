import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asPrinted, ceilingMs, runnerBuildCause } from '../../src/mobile/agent.ts';

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

test('why the iOS runner did not build, read from the end of its log', () => {
  // 2026-09-27: nine mlogins in a row, each « xcodebuild build-for-testing failed », each this.
  const missing = [
    'Command line invocation:',
    '    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild build-for-testing -project …',
    'xcodebuild: error: Unable to find a destination matching the provided destination specifier:',
    '\t\t{ platform:iOS Simulator, id:EDAE8BF1 }',
    '\tIneligible destinations for the "AgentDeviceRunner" scheme:',
    '\t\t{ platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device, error:iOS 26.5 is not installed. Please download and install the platform from Xcode > Settings > Components. }',
  ].join('\n');
  assert.match(runnerBuildCause(missing), /^iOS 26\.5 is not installed \(Xcode > Settings > Components/);
  assert.match(runnerBuildCause(missing.split('\n').slice(0, 4).join('\n')), /no simulator destination/);
  // A compile error: its own line. An older failure before the last build is not this one's cause.
  const compile = 'xcodebuild build-for-testing\nerror: iOS 1 is not installed\nxcodebuild build-for-testing -project x\nRunner.swift:12:5: error: cannot find foo in scope\n** TEST BUILD FAILED **';
  assert.equal(runnerBuildCause(compile), 'Runner.swift:12:5: error: cannot find foo in scope');
  assert.equal(runnerBuildCause('xcodebuild build-for-testing\n** TEST BUILD SUCCEEDED **'), '');
});
