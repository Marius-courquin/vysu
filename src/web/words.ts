// A step line cut into words the way the bash engine's `eval` cut it: `click "Se connecter"` is one
// label, `fill 'E-mail' "$VYSU_X"` two words with the variable read, a `#` at the start of a word the
// end of the line. What only a shell can run — a pipe, a redirection, a command substitution — is
// refused rather than run: a step is a line of a flow, not a script.

export class StepSyntax extends Error {}

type Lookup = (name: string) => string;

export function shellWords(text: string, lookup: Lookup): string[] {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const end = (): void => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  // $NAME or ${NAME}, the index at the `$`; returns the value and moves past it, or null for a lone `$`.
  const expand = (): string | null => {
    const next = text[i + 1];
    if (next === '(') throw new StepSyntax('a command substitution');
    if (next === '{') {
      const close = text.indexOf('}', i + 2);
      const name = close < 0 ? '' : text.slice(i + 2, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new StepSyntax('a parameter expansion this reader does not know');
      i = close + 1;
      return lookup(name);
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
    if (!m) return null;
    i += 1 + m[0].length;
    return lookup(m[0]);
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      end();
      i++;
    } else if (c === '#' && !has) {
      break;
    } else if (';|&<>()'.includes(c)) {
      throw new StepSyntax(`« ${c} » is shell syntax a step does not run`);
    } else if (c === '`') {
      throw new StepSyntax('a command substitution');
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new StepSyntax('a single quote that never closes');
      cur += text.slice(i + 1, close);
      has = true;
      i = close + 1;
    } else if (c === '"') {
      has = true;
      i++;
      for (;;) {
        const d = text[i];
        if (d === undefined) throw new StepSyntax('a double quote that never closes');
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\' && '$`"\\\n'.includes(text[i + 1] ?? '')) {
          cur += text[i + 1];
          i += 2;
        } else if (d === '$') {
          const v = expand();
          if (v === null) {
            cur += '$';
            i++;
          } else cur += v;
        } else if (d === '`') {
          throw new StepSyntax('a command substitution');
        } else {
          cur += d;
          i++;
        }
      }
    } else if (c === '\\') {
      if (i + 1 < text.length) {
        cur += text[i + 1];
        has = true;
      }
      i += 2;
    } else if (c === '$') {
      const v = expand();
      if (v === null) {
        cur += '$';
        has = true;
        i++;
        continue;
      }
      // Unquoted, a value is split on its blanks, as bash splits it.
      const parts = v.split(/[ \t\n]+/);
      parts.forEach((p, k) => {
        if (k > 0) end();
        if (p) {
          cur += p;
          has = true;
        }
      });
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  end();
  return words;
}
