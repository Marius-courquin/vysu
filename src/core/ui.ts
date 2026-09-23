// The three things a report line is allowed to say, and no fourth: it is fine (with the version), it
// is missing and optional (what it unlocks, and the command), it is missing and required (the
// command). `summary` counts them and repeats every command in one block, so the reader of
// `vysu setup` never has to work out what was blocking and what was noise.

// Colours only when the stream is a terminal, NO_COLOR is unset (https://no-color.org) and
// `--no-color` / VYSU_NO_COLOR were not given. Decided per stream: stdout carries the report,
// stderr carries `die`.
let colorWanted = ['', '0', 'no', 'false'].includes(process.env.VYSU_NO_COLOR ?? '');

export const marks = { ok: '✓', warn: '!', miss: '✗', info: '·', headOn: '', headOff: '', errOn: '', errOff: '' };

function paint(): void {
  const out = colorWanted && !process.env.NO_COLOR && process.stdout.isTTY === true;
  const err = colorWanted && !process.env.NO_COLOR && process.stderr.isTTY === true;
  marks.ok = out ? '\x1b[32m✓\x1b[0m' : '✓';
  marks.warn = out ? '\x1b[33m!\x1b[0m' : '!';
  marks.miss = out ? '\x1b[31m✗\x1b[0m' : '✗';
  marks.info = out ? '\x1b[2m·\x1b[0m' : '·';
  marks.headOn = out ? '\x1b[1m' : '';
  marks.headOff = out ? '\x1b[0m' : '';
  marks.errOn = err ? '\x1b[31m' : '';
  marks.errOff = err ? '\x1b[0m' : '';
}
paint();

export function noColor(): void {
  colorWanted = false;
  paint();
}

// What the summary counts, and the commands it repeats. The same command named by three lines is
// one line to run: the block is a list of what to do, not a tally of what is wrong.
const tally = { ok: 0, warn: 0, miss: 0, todo: [] as string[] };

function todo(cmd: string | undefined): void {
  if (cmd && !tally.todo.includes(cmd)) tally.todo.push(cmd);
}

export function ok(text: string): void {
  process.stdout.write(`${marks.ok} ${text}\n`);
  tally.ok++;
}
export function warn(text: string, cmd?: string): void {
  process.stdout.write(`${marks.warn} ${text}${cmd ? ` → ${cmd}` : ''}\n`);
  todo(cmd);
  tally.warn++;
}
export function miss(text: string, cmd?: string): void {
  process.stdout.write(`${marks.miss} ${text}${cmd ? ` → ${cmd}` : ''}\n`);
  todo(cmd);
  tally.miss++;
}
export function info(text: string): void {
  process.stdout.write(`${marks.info} ${text}\n`);
}
export function head(text: string): void {
  process.stdout.write(`\n${marks.headOn}## ${text}${marks.headOff}\n`);
}

export function summary(next: string[] = []): void {
  head('summary');
  let out = `ready: ${tally.ok} · optional missing: ${tally.warn} · required missing: ${tally.miss}\n`;
  if (tally.todo.length) out += `\nrun:\n${tally.todo.map((c) => `  ${c}\n`).join('')}`;
  if (next.length) out += `\nnext:\n${next.map((s) => `  ${s}\n`).join('')}`;
  process.stdout.write(out);
}

// The exit status of a report: a required tool missing is a failure, an optional one is not.
export function allRequiredPresent(): boolean {
  return tally.miss === 0;
}
