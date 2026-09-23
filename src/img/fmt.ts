// Python's way of writing numbers, strings and JSON, reproduced so a report line, an events.json or a
// cut.json reads byte for byte as it did when a Python script wrote it. Agents and the Remotion
// toolkit read these outputs: « 12.2 % » turning into « 12.3 % » on a tie is a changed word.

// f"{x:.{d}f}": the exact value rounded, half to even on a true tie (0.25 → « 0.2 »). JS toFixed rounds
// the exact value too, but sends a tie up; a tie is a dyadic number with d + 1 decimals at most, so a
// long enough expansion tells it from a neighbour that only prints like one.
export function pyFixed(x: number, d: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  let s = a.toFixed(d);
  if (a < 1e21) {
    const probe = a.toFixed(Math.min(100, d + 25));
    if (probe.endsWith(`5${'0'.repeat(24)}`)) {
      let kept = probe.slice(0, probe.length - 25);
      if (kept.endsWith('.')) kept = kept.slice(0, -1);
      if (Number(kept.at(-1)) % 2 === 0) s = kept;
    }
  }
  return (neg ? '-' : '') + s;
}

// f"{x:+.{d}f}".
export function pySigned(x: number, d: number): string {
  const s = pyFixed(x, d);
  return s.startsWith('-') ? s : `+${s}`;
}

// round(x, d) for a float: the same rounding as pyFixed, read back.
export function pyRoundTo(x: number, d: number): number {
  return Number(pyFixed(x, d));
}

// repr(float): the shortest digits that read back, Python's layout (« 30.0 », « 1e-05 », « 1e+16 »).
export function pyRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, e] = x.toExponential().split('e') as [string, string];
  const exp = Number(e);
  const sign = mant.startsWith('-') ? '-' : '';
  const digits = mant.replace('-', '').replace('.', '');
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
      return `${sign}${int}.${digits.slice(exp + 1) || '0'}`;
    }
    return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  const frac = digits.length > 1 ? `.${digits.slice(1)}` : '';
  return `${sign}${digits[0]}${frac}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

// f"{x:g}" / "%g": six significant digits, trailing zeros dropped.
export function pyG(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mant, e] = x.toExponential(5).split('e') as [string, string];
  const exp = Number(e);
  const strip = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp >= -4 && exp < 6) return strip(x.toFixed(5 - exp));
  return `${strip(mant)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

// float("…"): what Python accepts (spaces around, underscores between digits, inf / nan), else null.
export function pyFloat(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(s)) return NaN;
  if (!/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)(e[+-]?\d(_?\d)*)?$/.test(s)) return null;
  return Number(s.replace(/_/g, ''));
}

// int("…").
export function pyInt(v: string): number | null {
  const s = v.trim();
  return /^[+-]?\d(_?\d)*$/.test(s) ? Number(s.replace(/_/g, '')) : null;
}

// Python's whitespace (str.split(), str.strip()): wider than JS's \s on the control side, narrower on
// the BOM.
const WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const wsRun = new RegExp(`[${WS}]+`, 'g');
export const pySplit = (s: string): string[] => s.split(wsRun).filter(Boolean);
export const pyStrip = (s: string): string => s.replace(new RegExp(`^[${WS}]+|[${WS}]+$`, 'g'), '');
export const pyRstrip = (s: string): string => s.replace(new RegExp(`[${WS}]+$`), '');
export const isPySpace = (ch: string): boolean => new RegExp(`^[${WS}]$`).test(ch);

// str.strip(chars).
export function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

// str.splitlines(): every line boundary Python knows, the last line without its break.
export function pySplitlines(s: string): string[] {
  const out = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (out.length && out.at(-1) === '') out.pop();
  return out;
}

// sorted() on str: by code point, where JS compares UTF-16 units (an emoji then sorts before 「」).
export function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

// str.casefold(), near enough: upper then lower folds « ß » to « ss » and « ς » to « σ » as Python does.
export const casefold = (s: string): string => s.toUpperCase().toLowerCase();

// A float Python kept as a float: JSON writes it « 30.0 », where a JS number would say « 30 ».
const FLOAT: unique symbol = Symbol('float');
export interface PyFloat {
  readonly [FLOAT]: number;
}
export const float = (v: number): PyFloat => ({ [FLOAT]: v });
const isFloat = (v: unknown): v is PyFloat => typeof v === 'object' && v !== null && FLOAT in v;

function quote(s: string, ascii: boolean): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || (ascii && c > 0x7e)) {
      const units = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
      for (const u of units) out += `\\u${u.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

// json.dumps(v, ensure_ascii=ascii, indent=indent): Python's separators, its float spelling, its
// escapes. A plain JS number is an int unless it has a fraction; `float()` marks the others.
export function pyJson(v: unknown, opts: { indent?: number; ascii?: boolean } = {}): string {
  const ascii = opts.ascii ?? true;
  const indent = opts.indent;
  const walk = (x: unknown, level: number): string => {
    if (x === null || x === undefined) return 'null';
    if (x === true) return 'true';
    if (x === false) return 'false';
    if (isFloat(x)) {
      const f = x[FLOAT];
      return Number.isNaN(f) ? 'NaN' : !Number.isFinite(f) ? (f > 0 ? 'Infinity' : '-Infinity') : pyRepr(f);
    }
    if (typeof x === 'number') return Number.isInteger(x) ? String(x) : walk(float(x), level);
    if (typeof x === 'string') return quote(x, ascii);
    const entries: Array<[string | null, unknown]> = Array.isArray(x)
      ? x.map((e) => [null, e])
      : Object.entries(x as Record<string, unknown>).filter(([, e]) => e !== undefined);
    const [open, close] = Array.isArray(x) ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return open + close;
    const item = ([k, e]: [string | null, unknown]): string => (k === null ? '' : `${quote(k, ascii)}: `) + walk(e, level + 1);
    if (indent === undefined) return open + entries.map(item).join(', ') + close;
    const pad = ' '.repeat(indent * (level + 1));
    return `${open}\n${entries.map((e) => pad + item(e)).join(',\n')}\n${' '.repeat(indent * level)}${close}`;
  };
  return walk(v, 0);
}

// str(p) of a pathlib.Path: repeated and trailing slashes and « . » parts gone, what Python printed.
export function pyPath(p: string): string {
  if (!p) return '.';
  const abs = p.startsWith('/');
  const parts = p.split('/').filter((x) => x && x !== '.');
  const s = (abs ? '/' : '') + parts.join('/');
  return s || (abs ? '/' : '.');
}

// The message of an OSError as Python printed it: « [Errno 2] No such file or directory: 'a.png' ».
export function osError(e: unknown, path: string): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const known: Record<string, [number, string]> = {
    ENOENT: [2, 'No such file or directory'],
    EACCES: [13, 'Permission denied'],
    EISDIR: [21, 'Is a directory'],
    ENOTDIR: [20, 'Not a directory'],
  };
  const k = code ? known[code] : undefined;
  if (k) return `[Errno ${k[0]}] ${k[1]}: ${pyStrRepr(path)}`;
  return `cannot identify image file ${pyStrRepr(path)}`;
}

// repr(str): single quotes unless the string holds one and no double quote.
export function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(q === "'" ? /'/g : /"/g, `\\${q}`).replace(/\n/g, '\\n').replace(/\t/g, '\\t') + q;
}

// json.loads, keeping what Python kept: a number written with a point or an exponent stays a float
// (pyJson writes it back « 30.0 »), NaN and Infinity are read, the last of two equal keys wins.
const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y;
export function pyJsonParse(text: string): unknown {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`Expecting value: char ${i}`);
  };
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const k = str();
        ws();
        if (text[i++] !== ':') fail();
        o[k] = value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return o;
        } else fail();
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return a;
        } else fail();
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [['true', true], ['false', false], ['null', null], ['NaN', float(NaN)], ['Infinity', float(Infinity)], ['-Infinity', float(-Infinity)]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail();
    i += m[0].length;
    return m[2] || m[3] ? float(Number(m[0])) : Number(m[0]);
  };
  const str = (): string => {
    STRING.lastIndex = i;
    const end = STRING.exec(text);
    if (!end) return fail();
    i += end[0].length;
    return JSON.parse(end[0]) as string;
  };
  const v = value();
  ws();
  if (i < text.length) throw new SyntaxError(`Extra data: char ${i}`);
  return v;
}

// A float read by pyJsonParse, as a number.
export const num = (v: unknown): number | null => (typeof v === 'number' ? v : isFloat(v) ? v[FLOAT] : null);

// shlex.split(s): POSIX words, quotes joined to what touches them, a backslash escaping outside single
// quotes (inside double ones only before « " » or « \ »). Throws on an open quote or a final backslash,
// as shlex did.
export function shlexSplit(s: string): string[] {
  const words: string[] = [];
  let token = '';
  let inToken = false;
  let quote: '' | "'" | '"' = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote === "'") {
      if (c === "'") quote = '';
      else token += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\') {
        if (i + 1 >= s.length) throw new Error('No closing quotation');
        const n = s[++i]!;
        token += n === '"' || n === '\\' ? n : `\\${n}`;
      } else token += c;
      continue;
    }
    if (' \t\r\n'.includes(c)) {
      if (inToken) words.push(token);
      token = '';
      inToken = false;
    } else if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === '\\') {
      if (i + 1 >= s.length) throw new Error('No escaped character');
      token += s[++i]!;
      inToken = true;
    } else {
      token += c;
      inToken = true;
    }
  }
  if (quote) throw new Error('No closing quotation');
  if (inToken) words.push(token);
  return words;
}
