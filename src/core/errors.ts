// `die("<what went wrong>")`, and `die("<what went wrong>", "<the command that fixes it>")`: the
// second line is what the reader runs next, and it is the only thing they have to read. A die is an
// exception, so it crosses every await up to the entry point, which prints it, runs the cleanups
// (locks, a recorder in flight, a throwaway browser session) and exits 1.
import { marks } from './ui.ts';

export class VysuError extends Error {
  readonly next: string | undefined;
  readonly code: number;
  constructor(message: string, next?: string, code = 1) {
    super(message);
    this.next = next;
    this.code = code;
  }
}

// A command that has already said what it had to (a report that ends on exit 1, a flow step that
// failed) leaves with a status and no further message.
export class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function die(message: string, next?: string): never {
  throw new VysuError(message, next);
}

export function exit(code: number): never {
  throw new Exit(code);
}

export function log(message: string): void {
  process.stderr.write(`vysu: ${message}\n`);
}

export function printError(e: VysuError): void {
  process.stderr.write(`${marks.errOn}vysu: ${e.message}${marks.errOff}\n`);
  if (e.next) process.stderr.write(`next: ${e.next}\n`);
}

export function deprecated(old: string, now: string): void {
  process.stderr.write(`vysu: « ${old} » is the old spelling — use « ${now} » (it still works for now)\n`);
}

// What has to happen whichever way vysu ends. Async cleanups run at the end of the command and on a
// signal; the sync ones (a lock directory to remove) also run from process.on('exit'), which is the
// only hook left when something calls process.exit directly.
// `last` is for the locks: whatever was registered before the first lock was taken (a throwaway
// browser session to close) must still run while the lock keeps the next agent out.
type Cleanup = { run: () => void | Promise<void>; sync: boolean; last: boolean; done: boolean };
const cleanups: Cleanup[] = [];

const order = (): Cleanup[] => {
  const rev = [...cleanups].reverse();
  return [...rev.filter((c) => !c.last), ...rev.filter((c) => c.last)];
};

export function onCleanup(run: () => void | Promise<void>, sync = false, last = false): () => void {
  const c: Cleanup = { run, sync, last, done: false };
  cleanups.push(c);
  return () => {
    c.done = true;
  };
}

export async function runCleanups(): Promise<void> {
  // Last registered, first run: a recorder started after a lock is stopped before the lock goes.
  for (const c of order()) {
    if (c.done) continue;
    c.done = true;
    try {
      await c.run();
    } catch {
      // A cleanup that fails must not hide the error that ended the command.
    }
  }
}

process.on('exit', () => {
  for (const c of order()) {
    if (c.done || !c.sync) continue;
    c.done = true;
    try {
      void c.run();
    } catch {
      // Same: nothing more can be said at this point.
    }
  }
});
