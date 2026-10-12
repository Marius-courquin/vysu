// What `tap "<label>"` presses, read from real snapshots of the Nidz feed (Pixel 8 API 36, iPhone 17
// Pro, 2026-10) and from the loan card of the checker reports, whose centre is its photo. Also the
// other pure readers this lot added to snap.ts: the ANR dialog, a leftover Custom Tab, the spot that
// puts an iOS keyboard away, and a swipe with a duration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anrPackage, anrWait, customTabPackages, keyboardFreeSpot, keyboardUp, tapNorm, tapTarget, type SnapNode } from '../../src/mobile/snap.ts';
import { swipeAsPan } from '../../src/mobile/steps.ts';
import { scaleBoxes } from '../../src/mobile/api.ts';

const fixture = (name: string): SnapNode[] =>
  (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as { data: { nodes: SnapNode[] } }).data.nodes;
const android = fixture('tap-android-feed.json');
const ios = fixture('tap-ios-feed.json');

test('a label is matched whole, case and runs of spaces aside, never as a part', () => {
  assert.equal(tapNorm("  Test   ORDRE d’entrée "), "test ordre d'entrée");
  const hit = tapTarget(android, 'test   ORDRE pj');
  assert.equal(hit.kind, 'hit');
  // A part of a label is not pressed: the miss names the labels that hold it.
  assert.deepEqual(tapTarget(android, 'Test ordre'), { kind: 'none', holders: ['Test ordre PJ'] });
  assert.deepEqual(tapTarget(android, 'Nulle part'), { kind: 'none', holders: [] });
  // --partial: the smallest node holding it.
  const part = tapTarget(android, 'Test ordre', true);
  assert.ok(part.kind === 'hit' && part.x === 607 && part.y === 946, JSON.stringify(part));
});

test('android: the title inside the card is pressed, not the card whose centre is its photo', () => {
  // « Test ordre PJ »: the card (0,785 1080×955, its centre at y 1262 on the photos 1076-1628) and its
  // title (169,918 875×55): the title.
  assert.deepEqual(tapTarget(android, 'Test ordre PJ'), { kind: 'hit', x: 607, y: 946, label: 'Test ordre PJ', note: '' });
  // A long title is printed once, on the card: its child carries it as `inheritsLabel`.
  assert.deepEqual(tapTarget(android, '[TEST motion] Ouverture A'), { kind: 'hit', x: 607, y: 514, label: '[TEST motion] Ouverture A', note: '' });
});

test('the loan card of the reports: one pressable, its photo in the middle, its texts around it', () => {
  const card: SnapNode[] = [
    { index: 0, depth: 0, type: 'android.widget.FrameLayout', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
    { index: 1, parentIndex: 0, depth: 1, type: 'android.widget.Button', label: 'Appareil à raclette, Prêt, Disponible', rect: { x: 0, y: 300, width: 1080, height: 900 }, hittable: true },
    { index: 2, parentIndex: 1, depth: 2, type: 'android.widget.ImageView', label: 'Photo', rect: { x: 0, y: 420, width: 1080, height: 600 }, hittable: true },
    { index: 3, parentIndex: 1, depth: 2, type: 'android.widget.TextView', label: 'Appareil à raclette', rect: { x: 40, y: 1040, width: 700, height: 60 } },
    { index: 4, parentIndex: 1, depth: 2, type: 'android.widget.TextView', label: 'PRÊT', rect: { x: 40, y: 330, width: 120, height: 40 } },
  ];
  // The whole label: only the card carries it, and its centre (540, 750) is the photo.
  assert.deepEqual(tapTarget(card, 'Appareil à raclette, Prêt, Disponible'), {
    kind: 'hit',
    x: 390,
    y: 1070,
    label: 'Appareil à raclette, Prêt, Disponible',
    note: 'on its text « Appareil à raclette »',
  });
  // The title: its own node.
  // The title: its own node, the only one carrying that label (`alone`: a selector reaches it too).
  assert.deepEqual(tapTarget(card, 'Appareil à raclette'), { kind: 'hit', x: 390, y: 1070, label: 'Appareil à raclette', note: '', alone: true });
});

test('ios: a card whose texts are merged into it is pressed off its photos', () => {
  // « Test ordre PJ » (0,437 402×363) holds a photo scroller from y 548 to 758 across its width.
  assert.deepEqual(tapTarget(ios, 'Test ordre PJ'), { kind: 'hit', x: 201, y: 510, label: 'Test ordre PJ', note: 'beside what covers its centre' });
  // Under a sheet (`covered`): matched, not pressed.
  assert.deepEqual(tapTarget(ios, 'Azeaze'), { kind: 'hidden', label: 'Azeaze' });
  assert.deepEqual(tapTarget(ios, 'menu'), { kind: 'hit', x: 33, y: 87, label: 'Menu', note: '', alone: true });
});

test('a label under the keyboard is out of reach; a plain text above it puts the keyboard away', () => {
  const nodes: SnapNode[] = [
    { index: 0, depth: 0, type: 'Application', label: 'Nidz', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { index: 1, parentIndex: 0, depth: 1, type: 'Button', label: 'Retour', rect: { x: 14, y: 70, width: 38, height: 38 } },
    { index: 2, parentIndex: 0, depth: 1, type: 'StaticText', label: 'Nouvelle activité', rect: { x: 60, y: 76, width: 280, height: 24 } },
    { index: 3, parentIndex: 0, depth: 1, type: 'TextField', label: "Titre de l'activité", rect: { x: 16, y: 200, width: 370, height: 44 } },
    { index: 4, parentIndex: 0, depth: 1, type: 'Button', label: 'Suivant', rect: { x: 16, y: 700, width: 370, height: 50 } },
    { index: 5, parentIndex: 0, depth: 1, type: 'Keyboard', rect: { x: 0, y: 540, width: 402, height: 334 } },
    { index: 6, parentIndex: 0, depth: 1, type: 'StaticText', label: 'Sous le clavier', rect: { x: 16, y: 800, width: 200, height: 20 } },
  ];
  assert.deepEqual(tapTarget(nodes, 'Suivant'), { kind: 'hidden', label: 'Suivant' });
  assert.ok(keyboardUp(nodes));
  assert.deepEqual(keyboardFreeSpot(nodes), { x: 200, y: 88, label: 'Nouvelle activité' });
  // A text inside a button is no free spot; no keyboard, nothing to put away.
  assert.equal(keyboardFreeSpot(nodes.filter((n) => n.index !== 2)), null);
  assert.equal(keyboardFreeSpot(nodes.filter((n) => n.index !== 5)), null);
});

test("Android's ANR dialog, by its two buttons and by the focused window", () => {
  const dialog: SnapNode[] = [
    { type: 'android.widget.Button', label: "Fermer l'application", rect: { x: 100, y: 1200, width: 880, height: 140 } },
    { type: 'android.widget.Button', label: 'Attendre', rect: { x: 100, y: 1340, width: 880, height: 140 } },
  ];
  assert.equal(anrWait(dialog)?.label, 'Attendre');
  assert.equal(anrWait([{ label: 'Close app' }, { label: 'Wait', rect: { x: 1, y: 2, width: 3, height: 4 } }])?.label, 'Wait');
  // « Attendre » alone is an app's own button.
  assert.equal(anrWait(dialog.slice(1)), null);
  assert.equal(anrPackage('  mCurrentFocus=Window{3be321d u0 Application Not Responding: com.android.chrome}\n  mFocusedApp=ActivityRecord{…}'), 'com.android.chrome');
  assert.equal(anrPackage('  mCurrentFocus=Window{1 u0 fr.nidz.app.next.prep/fr.nidz.MainActivity}'), '');
});

test('a Custom Tab left open, by the activity that holds it', () => {
  const dump = [
    '    * Hist  #1: ActivityRecord{82655095 u0 com.android.chrome/org.chromium.chrome.browser.customtabs.CustomTabActivity t557}',
    '    * Hist  #0: ActivityRecord{1234 u0 fr.nidz.app.next.prep/.MainActivity t557}',
  ].join('\n');
  assert.deepEqual(customTabPackages(dump), ['com.android.chrome']);
  assert.deepEqual(customTabPackages('ActivityRecord{1 u0 fr.nidz/.MainActivity t1}'), []);
});

test('a swipe with a duration becomes the timed drag agent-device spells as gesture pan', () => {
  assert.deepEqual(swipeAsPan(['swipe', '540', '1900', '540', '1500', '900']), ['gesture', 'pan', '540', '1900', '0', '-400', '900']);
  assert.equal(swipeAsPan(['swipe', '540', '1900', '540', '1500']), null);
  assert.equal(swipeAsPan(['swipe', 'left']), null);
});

test('Android field boxes come back in the pixels a press takes', () => {
  assert.equal(scaleBoxes('[{"x":10,"y":300,"w":335,"h":45}]', 2.625), '[{"x":26,"y":788,"w":879,"h":118}]');
  assert.equal(scaleBoxes('[{"x":10}]', 1), '[{"x":10}]');
  assert.equal(scaleBoxes('not json', 2), 'not json');
});
