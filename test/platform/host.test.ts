import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetstatListeners, parseProcessLines } from '../../src/core/winps.ts';
import { cmdQuote, isWindows, processName, processTable, which } from '../../src/core/host.ts';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'windows', name), 'utf8');

test('the Windows process table, from the helper or from CIM', () => {
  const rows = parseProcessLines(fixture('processes.txt'));
  assert.deepEqual(
    rows.map((r) => [r.pid, r.ppid, r.name]),
    [
      [0, 0, '[System Process]'],
      [4, 0, 'System'],
      [1234, 880, 'claude.exe'],
      [5678, 1234, 'node.exe'],
      [9012, 5678, 'cmd.exe'],
      [4321, 9012, 'Git Bash Launcher.exe'],
    ],
  );
});

test('a Windows listener, whatever the language of the state column', () => {
  const text = fixture('netstat.txt');
  assert.deepEqual(parseNetstatListeners(text, 8081).sort(), [7001]);
  assert.deepEqual(parseNetstatListeners(text, 8100), [7002]);
  assert.deepEqual(parseNetstatListeners(text, 18081), [4444]);
  assert.deepEqual(parseNetstatListeners(text, 443), []);
  assert.deepEqual(parseNetstatListeners(text, 5353), []);
});

test('an argument for a cmd.exe command line', () => {
  assert.equal(cmdQuote('--omit=dev'), '--omit=dev');
  assert.equal(cmdQuote('agent-browser@latest'), 'agent-browser@latest');
  assert.equal(cmdQuote('C:\\Program Files\\nodejs\\npm.cmd'), '"C:\\Program Files\\nodejs\\npm.cmd"');
  assert.equal(cmdQuote('a "b" & c'), '"a ""b"" & c"');
  assert.equal(cmdQuote(''), '""');
});

// On the machine that runs the tests: the real table has this process under its parent, and a tool
// is found by its bare name (on Windows, npm is npm.cmd and never the extensionless Git Bash script).
test('the process table of this machine', () => {
  const t = processTable();
  const me = t.get(process.pid);
  assert.ok(me, 'this process is in the table');
  assert.equal(me.ppid, process.ppid);
  assert.match(me.name, isWindows ? /^node$/i : /node|bun/);
  assert.equal(processName(process.pid), me.name);
});

test('a tool on the PATH', () => {
  const npm = which('npm');
  assert.ok(npm, 'npm is on the PATH');
  if (isWindows) assert.match(npm, /\.cmd$/i);
  assert.equal(which('vysu-no-such-tool-here'), '');
});

// What the helper exists for: the table in tens of milliseconds instead of PowerShell's second.
test('the Windows helper is built and answers fast', { skip: !isWindows }, async () => {
  const { helperExe, windowsProcessLines } = await import('../../src/core/winps.ts');
  assert.ok(helperExe(), 'csc.exe built the helper');
  const t0 = performance.now();
  const rows = parseProcessLines(windowsProcessLines());
  const ms = performance.now() - t0;
  assert.ok(rows.some((r) => r.pid === process.pid));
  assert.ok(ms < 1000, `the table took ${ms.toFixed(0)} ms`);
});
