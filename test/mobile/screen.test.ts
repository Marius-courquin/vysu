// What a snapshot's nodes say (launcher, dev menu, red box, iOS alert), and Android's permission line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertStarting, hasExact, onDevMenu, onLauncher, redbox, redboxMessage, signature } from '../../src/mobile/snap.ts';
import { androidPermission, androidPermissionState, pmError, shQuote } from '../../src/mobile/mctl.ts';
import { isClone } from '../../src/mobile/pool.ts';

test('the launcher, the dev menu and the ready text', () => {
  assert.ok(onLauncher([{ type: 'StaticText', label: 'Development Build' }]));
  assert.ok(onLauncher([{ type: 'StaticText', label: 'There was a problem loading the project.' }]));
  assert.ok(!onLauncher([{ type: 'Button', label: 'Development Builds and more' }]));
  assert.ok(onDevMenu([{ label: 'Runtime version: 6aae29eb' }]));
  assert.ok(hasExact([{ label: 'x' }, { value: 'Bienvenue' }], 'Bienvenue'));
  assert.ok(!hasExact([{ label: 'Bienvenue Alice' }], 'Bienvenue'));
});

test('a red box and its first line', () => {
  const nodes = [
    { type: 'Other', label: 'short' },
    { type: 'StaticText', label: 'TypeError: undefined is not an object (evaluating x.y)' },
    { type: 'Button', label: 'DISMISS (ESC)' },
    { type: 'android.widget.Button', label: 'RELOAD (R, R)' },
  ];
  assert.ok(redbox(nodes));
  assert.equal(redboxMessage(nodes), 'TypeError: undefined is not an object (evaluating x.y)');
  assert.ok(!redbox(nodes.slice(0, 3)));
});

test('an iOS open-in alert, and a screen reduced to one string', () => {
  assert.ok(alertStarting([{ type: 'Alert', label: 'Ouvrir dans « Nidz » ?' }], ['Ouvrir dans', 'Open in']));
  assert.ok(!alertStarting([{ type: 'Button', label: 'Ouvrir dans' }], ['Ouvrir dans']));
  assert.equal(signature([{ label: 'a' }]), signature([{ label: 'a' }]));
  assert.notEqual(signature([{ label: 'a' }]), signature([{ label: 'b' }]));
});

test('android permissions as dumpsys and pm answer', () => {
  const dump = [
    '    runtime permissions:',
    '      android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SET|USER_FIXED|USER_SENSITIVE_WHEN_GRANTED]',
    '      android.permission.CAMERA: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]',
  ].join('\n');
  assert.equal(androidPermissionState(dump, 'android.permission.POST_NOTIFICATIONS'), 'granted=false USER_SET|USER_FIXED');
  assert.equal(androidPermissionState(dump, 'android.permission.CAMERA'), 'granted=true');
  assert.equal(androidPermissionState(dump, 'android.permission.RECORD_AUDIO'), '');
  assert.equal(androidPermission('photos', 33), 'android.permission.READ_MEDIA_IMAGES');
  assert.equal(androidPermission('photos', 30), 'android.permission.READ_EXTERNAL_STORAGE');
  assert.equal(androidPermission('com.x.CUSTOM', 30), 'com.x.CUSTOM');
  assert.equal(androidPermission('BODY_SENSORS', 30), 'android.permission.BODY_SENSORS');
  assert.equal(pmError('Exception occurred while executing:\njava.lang.SecurityException: Package x has not requested permission y\n\tat …'), 'Package x has not requested permission y');
  assert.equal(pmError('\nUnknown thing'), 'Unknown thing');
  assert.equal(shQuote("a'b?c&d"), "'a'\\''b?c&d'");
});

test('a vysu clone by its name', () => {
  assert.ok(isClone('iPhone 17 Pro (vysu 1)'));
  assert.ok(isClone('Nidz iPhone SE (iOS 18) (vysu 12)'));
  assert.ok(!isClone('Nidz iPhone SE (iOS 18)'));
  assert.ok(!isClone('iPhone (vysu x)'));
});
