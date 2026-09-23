// apns-sim — a simulated APNs push on the running iOS simulator. The preset file IS the APNs payload
// (aps.alert, mutable-content for a notification service extension, and whatever data fields the
// app's tap handler reads at the top level). No network, no certificate, no device token.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from '../../core/errors.ts';
import { lines } from '../../mobile/io.ts';
import type { PushDriver } from '../../push/push.ts';

export const driver: PushDriver = {
  describe: () => 'simulated APNs on the iOS simulator (simctl push), presets in .vysu/push/',
  async send(v, s) {
    if (s.target !== 'ios') v.die('apns-sim: the iOS simulator is the only target');
    const bundle = v.need('MOBILE_BUNDLE', 'the app id to deliver to');
    const json = v.payload(s.preset, s.fields);
    // agent-device (like simctl) wants the payload as a file.
    mkdirSync(v.state, { recursive: true });
    const file = join(v.state, 'push.apns');
    writeFileSync(file, json);
    const r = await v.mob('ios', ['push', bundle, file]);
    for (const l of lines(r.stdout).slice(-2)) v.say(l);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.code !== 0) exit(r.code);
  },
};
