// What an agent hands `vysu simctl` / `vysu adb` that names the device itself. vysu puts the owner's
// device in, and agents, used to the raw tools, named it too: `vysu simctl status_bar <UDID> override
// …` became `simctl status_bar <UDID> <UDID> override …` and printed the verb's usage, `vysu simctl io
// <UDID> screenshot` the same, `vysu adb -s emulator-5554 …` was refused even when that emulator was
// the owner's (audit, 25/09 → 12/10). The owner's own device named again is dropped; another one is
// refused, since it may be another session's.
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// The arguments after the verb with a device the agent named dropped, or why it cannot be.
export function simctlRest(rest: string[], udid: string): string[] | { refused: string } {
  const named = rest[0];
  if (named === undefined || !(UDID.test(named) || named === 'booted')) return rest;
  if (named === 'booted' || named.toUpperCase() === udid.toUpperCase()) return rest.slice(1);
  return { refused: named };
}

// A leading `-s <serial>` taken out of adb's arguments: the serial, and the rest.
export function adbSerial(args: string[]): { serial: string; rest: string[] } {
  if (args[0] === '-s' && args[1]) return { serial: args[1], rest: args.slice(2) };
  const m = /^-s(.+)$/.exec(args[0] ?? '');
  if (m) return { serial: m[1]!, rest: args.slice(1) };
  return { serial: '', rest: args };
}
