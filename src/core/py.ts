// The few Python behaviours the engine's outputs are defined by, reproduced so a layout, a glob or
// an escaped caption comes out as it always has.

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
  try {
    return new RegExp(`^${re}$`, 's').test(name);
  } catch {
    // A range written backwards (`[z-a]`) matches nothing in Python; a RegExp refuses to build it.
    return false;
  }
}

// `'%.<d>f' % x`: correctly rounded, an exact tie to the even digit (3.25 → « 3.2 »), where toFixed
// rounds a tie up. The digits of toFixed(d + 30) are the double's exact decimal expansion, so a tie is
// only taken for one.
export function pyFixed(x: number, digits: number): string {
  const plain = x.toFixed(digits);
  const long = Math.abs(x).toFixed(digits + 30);
  const cut = long.length - 30;
  if (!/^50*$/.test(long.slice(cut))) return plain;
  const kept = long.slice(0, cut).replace(/\.$/, '');
  const last = Number(kept.at(-1));
  if (last % 2 === 1) return plain;
  const down = (x < 0 ? '-' : '') + kept;
  return /^-0(\.0*)?$/.test(down) ? down.slice(1) : down;
}

// html.escape(s, quote=True).
export function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]!);
}
