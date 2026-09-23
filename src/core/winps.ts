// Two things Node cannot do on Windows, done by a 5 kB helper compiled once with the C# compiler every
// Windows 10 / 11 carries (.NET Framework 4, csc.exe), kept per user and named by the hash of its
// source, so an engine that changes it builds a new one.
//
// The process table, fast. `owner()` walks up from vysu to the agent that drives it, so every command
// that takes a lock reads the whole table once — and PowerShell's CIM answers in 0.5 to 1 s, more
// than the command itself. The table is a single Win32 call (CreateToolhelp32Snapshot, what
// `ps-list`'s fastlist does in C++): about 20 ms.
//
// A process that outlives vysu and holds none of its handles. Node starts a child with every
// inheritable handle of its own, and vysu's stdout is one: the pipe an agent reads vysu through. A
// service started that way keeps the pipe open, and the agent waits on `vysu up` until the service
// stops. The helper starts it with no handle inherited, its output redirected by cmd.exe.
//
// Where the helper cannot be built (no csc, a policy that blocks it), CIM answers for the table and
// Node's own detached spawn starts the service.
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

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Startup {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Started {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
  static extern bool Create(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup si, out Started pi);

  static void Out(string s) {
    byte[] bytes = new UTF8Encoding(false).GetBytes(s);
    using (System.IO.Stream o = Console.OpenStandardOutput()) o.Write(bytes, 0, bytes.Length);
  }

  // spawn <cwd> <command line>: no handle inherited, no window, its own process group; prints the pid.
  static int Spawn(string cwd, string line) {
    Startup si = new Startup();
    si.cb = Marshal.SizeOf(typeof(Startup));
    Started pi;
    if (!Create(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, 0x08000200, IntPtr.Zero, cwd, ref si, out pi)) return 1;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    Out(pi.dwProcessId + "\\n");
    return 0;
  }

  static int Main(string[] args) {
    if (args.Length == 3 && args[0] == "spawn") return Spawn(args[1], args[2]);
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
    Out(sb.ToString());
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

// A command line started with none of vysu's handles (see above), in `cwd`, with `env`: its pid, or
// 0 when the helper is not there to do it.
export function windowsDetach(line: string, cwd: string, env: NodeJS.ProcessEnv): number {
  const exe = helperExe();
  if (!exe) return 0;
  const r = spawnSync(exe, ['spawn', cwd, line], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const pid = Number((r.stdout ?? '').trim());
  return r.status === 0 && pid > 0 ? pid : 0;
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
