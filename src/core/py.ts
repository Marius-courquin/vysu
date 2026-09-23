// The few Python behaviours the engine's outputs were built on, reproduced so a layout, a glob or an
// escaped caption comes out the same as before the port.

// round(): half to even, which is not Math.round (round(2.5) is 2).
export function pyRound(x: number, digits = 0): number {
  const m = 10 ** digits;
  const v = x * m;
  const r = Math.round(v);
  const exactHalf = Math.abs(v % 1) === 0.5;
  const out = exactHalf && r % 2 !== 0 ? r - 1 : r;
  return out / m;
}

// fnmatch.fnmatchcase: * ? [seq] [!seq], case-sensitive, whole name.
export function fnmatch(name: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let set = pattern.slice(i + 1, end);
        if (set.startsWith('!')) set = `^${set.slice(1)}`;
        re += `[${set.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(name);
}

// html.escape(s, quote=True).
export function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]!);
}
