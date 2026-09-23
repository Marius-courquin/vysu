// The files vysu reads settings from — `.vysu/config`, `~/.vysu/machine.env`, `personas.env` — were
// written to be sourced by bash, and projects keep writing them that way. This reads the part of the
// shell those files use: `KEY=value` lines (with `export`, several per line, `;`), comments, the
// three kinds of quoting and their concatenation (`'Retour à l'"'"'accueil'`), `$VAR`, `${VAR}`,
// `${VAR:-default}` and its siblings, a leading `~`, and backslash escapes. Anything past that — a
// command substitution, a condition, a command — is refused with its line, and the caller decides
// whether a real shell may read the file instead.

export interface Assignment {
  key: string;
  value: string;
  line: number;
}

export class ShellUnsupported extends Error {
  readonly line: number;
  readonly text: string;
  constructor(line: number, text: string, why: string) {
    super(`line ${line}: ${why} (« ${text.trim().slice(0, 80)} »)`);
    this.line = line;
    this.text = text;
  }
}

type Lookup = (name: string) => string | undefined;

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

export function parseShellEnv(source: string, lookup: Lookup, home: string): Assignment[] {
  // A file checked out with Windows line endings reads like the same file with Unix ones.
  const text = source.replace(/\r\n?/g, '\n');
  const vars = new Map<string, string>();
  const get = (name: string): string => vars.get(name) ?? lookup(name) ?? '';
  const out: Assignment[] = [];
  let i = 0;
  let line = 1;

  const lineText = (): string => {
    const start = text.lastIndexOf('\n', i - 1) + 1;
    const end = text.indexOf('\n', i);
    return text.slice(start, end === -1 ? undefined : end);
  };
  const unsupported = (why: string): never => {
    throw new ShellUnsupported(line, lineText(), why);
  };

  // A word ends at an unquoted blank, newline or `;` — or at `}` inside `${VAR:-…}`.
  const readWord = (inBraces: boolean): string => {
    let value = '';
    if (text[i] === '~' && (i + 1 >= text.length || /[/\s;]/.test(text[i + 1]!) || (inBraces && text[i + 1] === '}'))) {
      value += home;
      i++;
    }
    for (;;) {
      const c = text[i];
      if (c === undefined) break;
      if (c === '}' && inBraces) break;
      if (!inBraces && (c === ' ' || c === '\t' || c === '\n' || c === ';')) break;
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end === -1) unsupported('a single quote that never closes');
        const chunk = text.slice(i + 1, end);
        line += chunk.split('\n').length - 1;
        value += chunk;
        i = end + 1;
      } else if (c === '"') {
        i++;
        for (;;) {
          const d = text[i];
          if (d === undefined) unsupported('a double quote that never closes');
          if (d === '"') {
            i++;
            break;
          }
          if (d === '\\') {
            const e = text[i + 1];
            if (e === '\n') {
              line++;
              i += 2;
            } else if (e === '$' || e === '`' || e === '"' || e === '\\') {
              value += e;
              i += 2;
            } else {
              value += '\\';
              i++;
            }
          } else if (d === '$') {
            value += expand();
          } else if (d === '`') {
            unsupported('a command substitution');
          } else {
            if (d === '\n') line++;
            value += d;
            i++;
          }
        }
      } else if (c === '\\') {
        const e = text[i + 1];
        if (e === undefined) {
          i++;
        } else if (e === '\n') {
          line++;
          i += 2;
        } else {
          value += e;
          i += 2;
        }
      } else if (c === '$') {
        value += expand();
      } else if (c === '`') {
        unsupported('a command substitution');
      } else if (!inBraces && '|&<>()'.includes(c)) {
        unsupported(`« ${c} » is shell syntax this reader does not run`);
      } else {
        if (c === '\n') line++;
        value += c;
        i++;
      }
    }
    return value;
  };

  // At a `$`: `$NAME`, `${NAME}`, `${NAME:-w}` `${NAME-w}` `${NAME:+w}` `${NAME+w}` `${NAME:=w}`.
  const expand = (): string => {
    const next = text[i + 1];
    if (next === '{') {
      i += 2;
      const start = i;
      while (i < text.length && NAME_CHAR.test(text[i]!)) i++;
      const name = text.slice(start, i);
      if (!name || !NAME_START.test(name[0]!)) unsupported('a parameter expansion this reader does not know');
      if (text[i] === '}') {
        i++;
        return get(name);
      }
      const op2 = text.slice(i, i + 2);
      const op = [':-', ':+', ':='].includes(op2) ? op2 : text[i] === '-' || text[i] === '+' || text[i] === '=' ? text[i]! : '';
      if (!op) unsupported('a parameter expansion this reader does not know');
      i += op.length;
      const word = readWord(true);
      if (text[i] !== '}') unsupported('a parameter expansion that never closes');
      i++;
      const set = vars.has(name) || lookup(name) !== undefined;
      const value = get(name);
      const empty = op.startsWith(':') ? value === '' : !set;
      switch (op.at(-1)) {
        case '-':
          return empty ? word : value;
        case '=':
          if (empty) vars.set(name, word);
          return empty ? word : value;
        default:
          return empty ? '' : word;
      }
    }
    if (next === '(') unsupported('a command substitution');
    if (next !== undefined && NAME_START.test(next)) {
      i++;
      const start = i;
      while (i < text.length && NAME_CHAR.test(text[i]!)) i++;
      return get(text.slice(start, i));
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) unsupported('a special parameter');
    i++;
    return '$';
  };

  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === ';') {
      i++;
      continue;
    }
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith('export', i) && /[ \t]/.test(text[i + 6] ?? '')) {
      i += 6;
      while (text[i] === ' ' || text[i] === '\t') i++;
    }
    const m = /[A-Za-z_][A-Za-z0-9_]*=/y;
    m.lastIndex = i;
    const hit = m.exec(text);
    if (!hit) unsupported('not an assignment');
    const key = hit![0].slice(0, -1);
    i += hit![0].length;
    const at = line;
    const value = readWord(false);
    vars.set(key, value);
    out.push({ key, value, line: at });
  }
  return out;
}

// How a value is written back so that bash and this reader both read it as it was given.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
