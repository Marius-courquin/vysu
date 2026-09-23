// Turns the Inter faces in assets/fonts/ into assets/glyphs/*.json: per character its advance and its
// outline as SVG path data, plus the kerning pairs, all in font units. The engine draws captions and
// titles from these files, so a contact sheet reads the same on every machine and never goes through
// fontconfig, whose first scan of the system fonts took seconds.
//
//   node scripts/build-glyphs.ts        (only when a font file changes; the output is committed)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';

const root = join(import.meta.dirname, '..');
const faces = [
  { file: 'inter-latin-400-normal.woff', out: 'inter-400.json' },
  { file: 'inter-latin-600-normal.woff', out: 'inter-600.json' },
];

mkdirSync(join(root, 'assets/glyphs'), { recursive: true });
for (const face of faces) {
  const buf = readFileSync(join(root, 'assets/fonts', face.file));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const units = font.unitsPerEm;
  const glyphs: Record<string, [number, string]> = {};
  const chars: string[] = [];
  for (let i = 0; i < font.glyphs.length; i++) {
    const g = font.glyphs.get(i);
    for (const code of g.unicodes ?? []) {
      const ch = String.fromCodePoint(code);
      glyphs[ch] = [Math.round(g.advanceWidth ?? 0), g.getPath(0, 0, units).toPathData(0)];
      chars.push(ch);
    }
  }
  const kern: Record<string, number> = {};
  for (const a of chars) {
    const ga = font.charToGlyph(a);
    for (const b of chars) {
      const k = Math.round(font.getKerningValue(ga, font.charToGlyph(b)));
      if (k) kern[a + b] = k;
    }
  }
  const data = { units, ascender: font.ascender, descender: font.descender, glyphs, kern };
  writeFileSync(join(root, 'assets/glyphs', face.out), JSON.stringify(data));
  console.log(`${face.out}: ${chars.length} characters, ${Object.keys(kern).length} kerning pairs`);
}
