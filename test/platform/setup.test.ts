import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionBelow } from '../../src/setup/engine.ts';
import { stampText } from '../../src/setup/skills.ts';
import { checkerAgentText } from '../../src/setup/checker.ts';
import { avdSpecs, ios18Runtime } from '../../src/setup/devices.ts';
import { fillTemplate } from '../../src/cmd/init.ts';

test('versions are compared on their numbers', () => {
  assert.equal(versionBelow('0.38.0', '0.38.1'), true);
  assert.equal(versionBelow('0.38.1', '0.38.1'), false);
  assert.equal(versionBelow('0.9.0', '0.10.0'), true);
  assert.equal(versionBelow('1.0.0', '0.99.99'), false);
  assert.equal(versionBelow('22.9.0', '22.18.0'), true);
  assert.equal(versionBelow('24.21.0', '22.18.0'), false);
  assert.equal(versionBelow('1.0', '1.0.0'), true);
});

test('a skill is stamped after its frontmatter, or on top without one', () => {
  assert.equal(stampText('---\nname: x\n---\nbody\n', '0.5.1'), '---\nname: x\n---\n\n<!-- vysu-skill 0.5.1 -->\nbody\n');
  assert.equal(stampText('---\nname: x\n---\nbody', '0.5.1'), '---\nname: x\n---\n\n<!-- vysu-skill 0.5.1 -->\nbody\n');
  assert.equal(stampText('# no frontmatter\n', '1.0.0'), '<!-- vysu-skill 1.0.0 -->\n\n# no frontmatter\n');
  assert.equal(stampText('---\nunclosed\n', '1.0.0'), '<!-- vysu-skill 1.0.0 -->\n\n---\nunclosed\n');
});

test('the checker definition takes the model, or loses the line', () => {
  const tpl = '---\nname: visual-checker\nmodel: sonnet\n---\n\nYou are a checker.\n';
  assert.equal(checkerAgentText(tpl, 'opus', '0.5.1'), '---\nname: visual-checker\nmodel: opus\n---\n<!-- vysu-agent 0.5.1 -->\n\nYou are a checker.\n');
  assert.equal(checkerAgentText(tpl, '', '0.5.1'), '---\nname: visual-checker\n---\n<!-- vysu-agent 0.5.1 -->\n\nYou are a checker.\n');
});

test('AVD specs split the way bash expanded them', () => {
  assert.deepEqual(avdSpecs('a:36:pixel_8:;b:36:pixel_8_pro:hw.lcd.width=1280 hw.lcd.density=480;c:30:pixel_4a'), [
    { name: 'a', api: '36', device: 'pixel_8', extra: '' },
    { name: 'b', api: '36', device: 'pixel_8_pro', extra: 'hw.lcd.width=1280 hw.lcd.density=480' },
    { name: 'c', api: '30', device: 'pixel_4a', extra: 'pixel_4a' },
  ]);
  assert.deepEqual(avdSpecs(''), []);
});

test('the newest iOS 18 runtime', () => {
  const json = JSON.stringify({
    runtimes: [
      { platform: 'iOS', version: '18.2', identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2' },
      { platform: 'iOS', version: '18.6', identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6' },
      { platform: 'iOS', version: '26.0', identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0' },
      { platform: 'watchOS', version: '18.0', identifier: 'w' },
    ],
  });
  assert.equal(ios18Runtime(json), 'com.apple.CoreSimulator.SimRuntime.iOS-18-6');
  assert.equal(ios18Runtime('{"runtimes":[]}'), '');
  assert.equal(ios18Runtime('not json'), '');
});

test('init fills the template and comments out what was left empty', () => {
  const tpl = "# the web app\nVYSU_ORIGIN='http://localhost:3000'\n# VYSU_BASELINE_ORIGIN='https://main.example.com'\n# VYSU_STATE=\"$HOME/x\"\nVYSU_AUTH='none'";
  assert.equal(
    fillTemplate(tpl, { VYSU_ORIGIN: 'http://localhost:5173', VYSU_BASELINE_ORIGIN: '', VYSU_AUTH: "it's" }),
    "# the web app\nVYSU_ORIGIN='http://localhost:5173'\n# VYSU_BASELINE_ORIGIN=''\n# VYSU_STATE=\"$HOME/x\"\nVYSU_AUTH='it'\"'\"'s'\n",
  );
});

test('update prints the CHANGELOG entries since the version it was on', async () => {
  const { changelogSince } = await import('../../src/cmd/update.ts');
  const log = '# Changelog\n\n## 0.6.0 — 2026-10-01\n\nNew.\n\n## 0.5.1 — 2026-09-23\n\nOld.\n';
  assert.equal(changelogSince(log, '0.5.1'), '## 0.6.0 — 2026-10-01\n\nNew.\n\n');
  assert.equal(changelogSince(log, '0.6.0'), '');
  assert.equal(changelogSince(log, '0.1.0'), '## 0.6.0 — 2026-10-01\n\nNew.\n\n## 0.5.1 — 2026-09-23\n\nOld.\n');
});

test('a size the way du -h writes it', async () => {
  const { humanSize } = await import('../../src/cmd/doctor.ts');
  assert.equal(humanSize(0), '0B');
  assert.equal(humanSize(4096), '4.0K');
  assert.equal(humanSize(12 * 1024 * 1024), '12M');
  assert.equal(humanSize(1.84 * 1024 ** 3), '1.8G');
});
