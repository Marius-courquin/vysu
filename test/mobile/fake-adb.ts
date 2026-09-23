// A stand-in for adb, for the tests that need a device and must not touch one: emulators that answer
// to their AVD name, a screencap that is a tiny PNG, and every call written down with the serial it
// addressed. A shell script, so the tests that use it skip on Windows.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// 4x8, black, RGB.
export function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.alloc(1 + 4 * 3)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export interface FakeAndroid {
  dir: string;
  bin: string;
  state: string;
  env: NodeJS.ProcessEnv;
  calls: () => string[];
  vysu: (args: string[], timeoutMs?: number) => Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>;
}

// `emulators`: serial → AVD name. `density`: what `wm density` answers ('' = nothing, as a restarting
// adbd does). `agentDevice`: a fake agent-device too, with a session on every emulator and a screen
// showing « Home »; without it there is none on the PATH. The environment names the first AVD.
export function fakeAndroid(o: { emulators?: Record<string, string>; density?: string; extra?: string; agentDevice?: boolean } = {}): FakeAndroid {
  const emulators = o.emulators ?? { 'emulator-5598': 'fake_avd' };
  const dir = mkdtempSync(join(tmpdir(), 'vysu-fake-adb-'));
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(dir, 'proj', '.vysu'), { recursive: true });
  writeFileSync(join(dir, 'proj', '.vysu', 'config'), 'VYSU_PROJECT=fake\n');
  writeFileSync(join(dir, 'tiny.png'), tinyPng());
  const serials = Object.keys(emulators);
  const avdCases = Object.entries(emulators)
    .map(([s, a]) => `  *"-s ${s} emu avd name"*) printf '${a}\\r\\nOK\\r\\n'; exit 0;;`)
    .join('\n');
  const density = o.density ?? 'Physical density: 420';
  writeFileSync(
    join(bin, 'adb'),
    `#!/bin/sh
D='${dir}'
echo "ANDROID_SERIAL=\${ANDROID_SERIAL:-} $*" >> "$D/adb.log"
case "$1" in
  devices) printf 'List of devices attached\\n${serials.map((s) => `${s}\\tdevice\\n`).join('')}'; exit 0;;
  -s) ;;
  *) if [ ${serials.length} -gt 1 ] && [ -z "\${ANDROID_SERIAL:-}" ]; then echo "adb: more than one device/emulator" >&2; exit 1; fi;;
esac
case "$*" in
${avdCases}
  *"wm density"*) ${density ? `echo '${density}'` : 'exit 1'};;
  *"exec-out screencap -p"*) cat "$D/tiny.png";;
  *"dumpsys window"*) echo "  mCurrentFocus=Window{1 u0 com.example/com.example.MainActivity}";;
${o.extra ?? ''}
esac
exit 0
`,
  );
  chmodSync(join(bin, 'adb'), 0o755);
  // node alone, not its folder: a global agent-device beside it would drive a real device.
  symlinkSync(process.execPath, join(bin, 'node'));
  if (o.agentDevice) {
    const sessions = Object.values(emulators).map((a) => `{"name":"fake-android-${a.replaceAll('_', '-')}"}`);
    writeFileSync(
      join(bin, 'agent-device'),
      `#!/bin/sh
echo "$*" >> '${dir}/agent-device.log'
case "$*" in
  "session list --json"*) echo '{"success":true,"data":{"sessions":[${sessions.join(',')}]}}';;
  *) echo '{"success":true,"data":{"nodes":[{"label":"Home"}]}}';;
esac
`,
    );
    chmodSync(join(bin, 'agent-device'), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    HOME: join(dir, 'home'),
    PATH: `${bin}:/usr/bin:/bin`,
    VYSU_STATE: state,
    VYSU_SHOTS: join(dir, 'shots'),
    VYSU_OWNER: 'test-owner',
    VYSU_PROJECT_DIR: join(dir, 'proj'),
    VYSU_ANDROID_AVD: Object.values(emulators)[0],
    VYSU_LOCK_WAIT: '2',
  };
  return {
    dir,
    bin,
    state,
    env,
    calls: () => {
      try {
        return readFileSync(join(dir, 'adb.log'), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    vysu: (args, timeoutMs = 20000) =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env, cwd: join(dir, 'proj'), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
        child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, ms: Date.now() - t0 });
        });
      }),
  };
}
