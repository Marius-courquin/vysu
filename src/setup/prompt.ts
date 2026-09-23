// The questions setup, init and `persona add` ask: the prompt on stderr, the answer one line of stdin.
// The answers may also be piped in (an agent, a test), several at once: each question takes the next
// line, and a closed stdin answers '' — the default, exactly as a bare Enter would.
import { createInterface, type Interface } from 'node:readline';
import { onCleanup } from '../core/errors.ts';

let rl: Interface | undefined;
// Lines read before a question asked for them: several answers piped in one write, or typed ahead.
const queue: string[] = [];
let waiting: ((line: string | undefined) => void) | undefined;
let ended = false;
let letGo = false;
let cleanup = false;

function nextLine(): Promise<string | undefined> {
  if (queue.length) return Promise.resolve(queue.shift());
  if (ended) return Promise.resolve(undefined);
  if (!rl) {
    rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const w = waiting;
      waiting = undefined;
      if (w) w(line);
      else queue.push(line);
    });
    rl.on('close', () => {
      rl = undefined;
      // Closed by the end of stdin, not by askSecret taking the terminal over.
      if (!letGo) ended = true;
      letGo = false;
      const w = waiting;
      waiting = undefined;
      w?.(undefined);
    });
    if (!cleanup) onCleanup(() => rl?.close());
    cleanup = true;
  }
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

export async function ask(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return (await nextLine()) ?? '';
}

// Whether a human can answer: stdin is a terminal.
export const interactive = (): boolean => process.stdin.isTTY === true;

// A password: from a pipe (or typed ahead), the next line like any answer; on a terminal, typed
// without echo (raw mode, one key at a time). The line reader lets go of stdin first, or it would read
// the keys too; a question after this one opens a new reader. The newline the silent read swallowed
// is printed back.
export async function askSecret(prompt: string): Promise<string> {
  if (!interactive() || queue.length) {
    const answer = await ask(prompt);
    process.stderr.write('\n');
    return answer;
  }
  process.stderr.write(prompt);
  if (rl) {
    letGo = true;
    rl.close();
  }
  const stdin = process.stdin;
  const answer = await new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
  });
  process.stderr.write('\n');
  return answer;
}
