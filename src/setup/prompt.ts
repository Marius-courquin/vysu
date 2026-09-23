// The questions setup and init ask: the prompt on stderr, the answer one line of stdin. The answers
// may also be piped in (an agent, a test), several at once: each question takes the next line, and a
// closed stdin answers '' — the default, exactly as a bare Enter would.
import { createInterface, type Interface } from 'node:readline';
import { onCleanup } from '../core/errors.ts';

let rl: Interface | undefined;
let lines: AsyncIterator<string> | undefined;
let ended = false;

export async function ask(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  if (ended) return '';
  if (!lines) {
    rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
    lines = rl[Symbol.asyncIterator]();
    onCleanup(() => rl?.close());
  }
  const next = await lines.next();
  if (next.done) {
    ended = true;
    return '';
  }
  return next.value;
}

// Whether a human can answer: stdin is a terminal.
export const interactive = (): boolean => process.stdin.isTTY === true;
