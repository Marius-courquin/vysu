// The Windows process table, fast. `owner()` walks up from vysu to the agent that drives it, so every
// command that takes a lock reads the whole table once — and PowerShell's CIM answers in 0.5 to 1 s,
// more than the command itself. The table is a single Win32 call (CreateToolhelp32Snapshot, what
// `ps-list`'s fastlist does in C++): a 4 kB helper compiled once with the C# compiler every Windows
// 10 / 11 carries (.NET Framework 4, csc.exe) answers in about 20 ms. It is kept per user, named by
// the hash of its source, so an engine that changes it builds a new one. Where it cannot be built
// (no csc, a policy that blocks it) the CIM query stays the answer, once per command.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// C# 5, the version the Framework's csc takes. Bytes written straight to stdout in UTF-8: setting
// Console.OutputEncoding throws when no console is attached, which is how vysu starts it.
const SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Text;

static class VysuPs {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")] static extern bool First(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")] static extern bool Next(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static int Main() {
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return 1;
    Entry e = new Entry();
    e.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
    StringBuilder sb = new StringBuilder();
    if (First(snap, ref e)) {
      do {
        sb.Append(e.th32ProcessID).Append('\\t').Append(e.th32ParentProcessID).Append('\\t').Append(e.szExeFile).Append('\\n');
      } while (Next(snap, ref e));
    }
    CloseHandle(snap);
    byte[] bytes = new UTF8Encoding(false).GetBytes(sb.ToString());
    using (System.IO.Stream o = Console.OpenStandardOutput()) o.Write(bytes, 0, bytes.Length);
    return 0;
  }
}
`;

const HASH = createHash('sha1').update(SOURCE).digest('hex').slice(0, 10);

function cacheDir(): string {
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'vysu');
}

function csc(): string {
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (existsSync(p)) return p;
  }
  return '';
}

// The helper, built on first use. Built under a name of this process and renamed into place, so two
// commands starting at once never run a half-written exe; a failed build leaves a marker, so the next
// command does not pay the compiler again for nothing.
export function helperExe(): string {
  const dir = cacheDir();
  const exe = join(dir, `ps-${HASH}.exe`);
  if (existsSync(exe)) return exe;
  const failed = `${exe}.failed`;
  if (existsSync(failed)) return '';
  const compiler = csc();
  if (!compiler) return '';
  try {
    mkdirSync(dir, { recursive: true });
    const src = join(dir, `ps-${HASH}.${process.pid}.cs`);
    const tmp = join(dir, `ps-${HASH}.${process.pid}.exe`);
    writeFileSync(src, SOURCE);
    const r = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${tmp}`, src], { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
    rmSync(src, { force: true });
    if (r.status !== 0 || !existsSync(tmp)) {
      rmSync(tmp, { force: true });
      writeFileSync(failed, `${r.stdout ?? ''}${r.stderr ?? ''}`);
      return '';
    }
    try {
      renameSync(tmp, exe);
    } catch {
      rmSync(tmp, { force: true });
    }
    return existsSync(exe) ? exe : '';
  } catch {
    return '';
  }
}

// « pid<TAB>ppid<TAB>name » lines, from the helper or from CIM: the same shape either way.
export function windowsProcessLines(): string {
  const exe = helperExe();
  if (exe) {
    const r = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (r.status === 0 && r.stdout) return r.stdout;
  }
  // wmic is gone from recent Windows; CIM through PowerShell is the one table every Windows has.
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" }'],
    { encoding: 'utf8', windowsHide: true },
  );
  return r.stdout ?? '';
}

export interface RawProc {
  pid: number;
  ppid: number;
  name: string;
}

export function parseProcessLines(text: string): RawProc[] {
  const out: RawProc[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, ...rest] = line.split('\t');
    const name = rest.join('\t');
    if (!pid || !ppid || !name || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue;
    out.push({ pid: Number(pid), ppid: Number(ppid), name });
  }
  return out;
}

// `netstat -ano`, all protocols and both address families: a Node server listens on [::] and
// shows in the IPv6 table only, which `-p tcp` leaves out. The state column is translated on a
// non-English Windows (« ABHÖREN »), so a listener is told by what does not change: a TCP socket
// whose remote end is still the wildcard.
export function parseNetstatListeners(text: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0]?.toUpperCase() !== 'TCP' || f.length < 5) continue;
    if (!f[1]!.endsWith(`:${port}`)) continue;
    if (!['0.0.0.0:0', '[::]:0', '*:*'].includes(f[2]!)) continue;
    const pid = Number(f[f.length - 1]);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}
