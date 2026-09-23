// webhook — a real push, sent by an endpoint the project owns: vysu POSTs
// `{email, preset, platform, fields}` to VYSU_PUSH_WEBHOOK_URL and prints whatever the endpoint
// answers. The endpoint holds the credentials and the device tokens; vysu holds neither.
import { existsSync } from 'node:fs';
import type { PushDriver } from '../../push/push.ts';
import { pyJson, pyPrint } from '../../push/pyjson.ts';

const head = (s: string, n: number): string => Buffer.from(s, 'utf8').subarray(0, n).toString('utf8');

export const driver: PushDriver = {
  describe: (v) => `POST to ${v.cfg('PUSH_WEBHOOK_URL') || '(VYSU_PUSH_WEBHOOK_URL is not set)'}`,
  async send(v, s) {
    const url = v.cfg('PUSH_WEBHOOK_URL');
    if (!url) v.die('webhook: VYSU_PUSH_WEBHOOK_URL is not set');
    if (!existsSync(v.personas)) v.die(`no ${v.personas} (vysu persona add <name>)`);
    const email = v.personaVar(s.target, 'EMAIL');
    if (!email) v.die(`persona '${s.target}' not in ${v.personas}`);
    // The fields go over as an object, and a preset the project also keeps locally is not read here:
    // the endpoint owns the payload, vysu only names which one and with what.
    const fields: Record<string, string> = {};
    for (const a of s.fields) {
      const eq = a.indexOf('=');
      if (eq >= 0) fields[a.slice(0, eq)] = a.slice(eq + 1);
    }
    const body = `{"email":"${email}","preset":"${s.preset}"${s.platform ? `,"platform":"${s.platform}"` : ''},"fields":${pyJson(fields)}}`;
    let code = 0;
    let out = '';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30000) });
      code = r.status;
      out = await r.text();
    } catch {
      code = 0;
    }
    if (code === 200) {
      let d: unknown;
      try {
        d = JSON.parse(out);
      } catch {
        return;
      }
      const results = d && typeof d === 'object' && !Array.isArray(d) ? (d as { results?: unknown }).results : undefined;
      if (results === undefined || results === null) {
        v.say(pyJson(d, false));
        return;
      }
      for (const r of results as Array<Record<string, unknown>>) {
        v.say([pyPrint(r.platform), pyPrint(r.deviceModel), r.ok ? 'OK' : 'FAILED', pyPrint(r.messageName || r.error)].join(' '));
      }
    } else if (code === 404) v.say(`webhook: no ${s.platform} device registered for ${email}, or the endpoint does not serve ${url}`);
    else if (code === 0) v.die(`webhook unreachable at ${url} (VPN up?)`);
    else v.say(`webhook: HTTP ${code} — ${head(out, 200)}`);
  },
};
