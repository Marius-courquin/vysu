// json.dumps as Python writes it by default — `", "` and `": "` between items, non-ASCII escaped
// unless asked not to: what the drivers have always sent and printed, byte for byte.
function str(s: string, ascii: boolean): string {
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
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (ascii && c > 0x7e) {
      for (const unit of ch.length === 2 ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [c]) out += `\\u${unit.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

export function pyJson(v: unknown, ascii = true): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN';
  if (typeof v === 'string') return str(v, ascii);
  if (Array.isArray(v)) return `[${v.map((x) => pyJson(x, ascii)).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${str(k, ascii)}: ${pyJson(x, ascii)}`)
    .join(', ')}}`;
}

// print(x) of a value json.load handed back: None, True, the string itself.
export function pyPrint(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return pyRepr(v);
}
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`)
    .join(', ')}}`;
}
