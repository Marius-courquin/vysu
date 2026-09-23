// Where the mobile code's lines go. A command prints straight to the terminal; `vysu mdo` runs each
// step with its lines collected, then answers the step in one line of its own — what bash did by
// redirecting a step's stdout and stderr into files it read back. `quiet` is `>/dev/null` (and
// `2>&1` with `{ err: true }`).
type Stream = string[] | 'pass' | 'drop';
interface Sink {
  out: Stream;
  err: Stream;
}
const stack: Sink[] = [];

function route(which: 'out' | 'err', text: string): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i]![which];
    if (s === 'pass') continue;
    if (s === 'drop') return;
    s.push(text);
    return;
  }
  (which === 'out' ? process.stdout : process.stderr).write(`${text}\n`);
}

// One line (or several joined by \n) on stdout.
export function say(text: string): void {
  route('out', text);
}

// One line on stderr; `why()` is the same with vysu's prefix.
export function tell(text: string): void {
  route('err', text);
}

export function why(text: string): void {
  route('err', `vysu: ${text}`);
}

// What a step said before it died, for the runner that reports it: a die crosses every await as it
// always does, carrying the lines along.
export class Captured extends Error {
  readonly out: string[];
  readonly err: string[];
  readonly inner: unknown;
  constructor(inner: unknown, out: string[], err: string[]) {
    super(inner instanceof Error ? inner.message : String(inner));
    this.inner = inner;
    this.out = out;
    this.err = err;
  }
}

export async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const sink: Sink = { out, err };
  stack.push(sink);
  try {
    return { value: await fn(), out, err };
  } catch (e) {
    throw new Captured(e, out, err);
  } finally {
    stack.splice(stack.lastIndexOf(sink), 1);
  }
}

export async function quiet<T>(fn: () => Promise<T>, o: { err?: boolean } = {}): Promise<T> {
  const sink: Sink = { out: 'drop', err: o.err ? 'drop' : 'pass' };
  stack.push(sink);
  try {
    return await fn();
  } finally {
    stack.splice(stack.lastIndexOf(sink), 1);
  }
}

// The lines of a text, split the way `read` splits them (a trailing newline makes no empty line).
export function lines(text: string): string[] {
  if (!text) return [];
  const l = text.replace(/\r/g, '').split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

export function lastLine(text: string): string {
  const l = lines(text);
  return l[l.length - 1] ?? '';
}

// VYSU_DEBUG=mobile: when each wait started and what it saw, on stderr, stamped from the start of
// the command. Silent otherwise.
const t0 = Date.now();
export function trace(text: string): void {
  if (process.env.VYSU_DEBUG === 'mobile') process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}\n`);
}
