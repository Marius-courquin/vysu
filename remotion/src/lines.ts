import { measureText } from '@remotion/layout-utils';
import { parseAccent, type TitleSegment } from './text.ts';

export type Line = TitleSegment[];

export type WrapInput = {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: string;
  maxWidth: number;
  // Nothing is measured before the faces are in, or the fallback font is what gets wrapped.
  fontsReady: boolean;
};

type Word = { text: string; accent: boolean };

function words(text: string): Word[] {
  return parseAccent(text).flatMap((segment) =>
    segment.text
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ text: word, accent: segment.accent })),
  );
}

function group(line: Word[]): Line {
  const out: Line = [];
  line.forEach((word, i) => {
    const last = out[out.length - 1];
    if (last && last.accent === word.accent) last.text += ` ${word.text}`;
    else out.push({ text: (i === 0 ? '' : ' ') + word.text, accent: word.accent });
  });
  return out;
}

// The Opening's title enters ONE LINE AT A TIME, so the film has to know where the lines fall
// instead of leaving the break to the browser: a greedy wrap on the measured width, with the
// accent phrase carried along word by word.
export function wrapAccent(input: WrapInput): Line[] {
  const all = words(input.text);
  if (!input.fontsReady || all.length === 0) return [parseAccent(input.text)];

  const width = (line: Word[]) =>
    measureText({
      text: line.map((w) => w.text).join(' '),
      fontFamily: input.fontFamily,
      fontSize: input.fontSize,
      fontWeight: input.fontWeight,
      letterSpacing: input.letterSpacing,
    }).width;

  // The accent phrase is one unit: it breaks BEFORE the phrase rather than inside it, so the
  // orange words never straddle two lines ("en une / minute"). A phrase too wide for a line of its
  // own falls back to word-by-word wrapping.
  const units: Word[][] = [];
  for (const word of all) {
    const last = units[units.length - 1];
    if (word.accent && last && last[0].accent) last.push(word);
    else units.push([word]);
  }
  const lines: Word[][] = [];
  let current: Word[] = [];
  for (const unit of units) {
    const pieces = unit.length > 1 && width(unit) > input.maxWidth ? unit.map((w) => [w]) : [unit];
    for (const piece of pieces) {
      const candidate = [...current, ...piece];
      if (current.length > 0 && width(candidate) > input.maxWidth) {
        lines.push(current);
        current = [...piece];
      } else {
        current = candidate;
      }
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map(group);
}
