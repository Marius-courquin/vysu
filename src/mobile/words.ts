// Small readers of what a step says: its words, its numbers, and the numbers it answers in.

// A step's words, quoted the way a shell quotes them but never expanded: `fill "Mot de passe"
// "pa$$word"` types what it says. Python's shlex.split, to the letter: POSIX quoting,
// a backslash escaping any character outside quotes and only `"` and `\` inside double quotes, an
// empty pair of quotes being an empty word. A step whose quotes do not close is said to be one, not
// run half-read.
export class WordsError extends Error {}

export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  const ws = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (i < s.length) {
    const c = s[i]!;
    if (ws(c)) {
      if (inWord) {
        out.push(cur);
        cur = '';
        inWord = false;
      }
      i++;
      continue;
    }
    inWord = true;
    if (c === '\\') {
      if (i + 1 >= s.length) throw new WordsError('No escaped character');
      cur += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new WordsError('No closing quotation');
      cur += s.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= s.length) throw new WordsError('No closing quotation');
        const d = s[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        if (d === '\\' && i + 1 >= s.length) throw new WordsError('No escaped character');
        cur += d;
        i++;
      }
      continue;
    }
    cur += c;
    i++;
  }
  if (inWord) out.push(cur);
  return out;
}

// `read -r -a`: whitespace-separated, nothing unquoted — what `shot <label> [--full]` is read with.
export const plainWords = (s: string): string[] => s.split(/[ \t\n]+/).filter(Boolean);

// Seconds as a step spells them (« 10 », « 2.5 »): digits and at most one dot.
export const secondsOk = (s: string): boolean => s !== '' && /^[0-9.]*$/.test(s) && !/\..*\./.test(s);
// → milliseconds, truncated as awk's %d truncates.
export const msOf = (s: string): number => Math.trunc(Number(s || '0') * 1000) || 0;

// Python's `%g`: six significant digits, no trailing zeros, an exponent past 1e6 or under 1e-4.
// The point a press hit is written this way into a take's rows.
export function pyG(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split('e');
    const mant = m!.includes('.') ? m!.replace(/0+$/, '').replace(/\.$/, '') : m!;
    const n = Number(e);
    return `${mant}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
  }
  const s = x.toFixed(Math.max(0, 5 - exp));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

// The first sentence of an agent-device error: what follows is agent-device explaining its policy,
// not this screen.
export function firstSentence(message: string): string {
  const m = message.trim();
  const re = /(?<=[.;])\s|\s\(/;
  const cut = re.exec(m);
  return (cut ? m.slice(0, cut.index) : m).replace(/[.;]+$/, '');
}
