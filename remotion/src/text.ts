// `*word*` markup in a title: the site's hero puts one orange, hand-underlined phrase inside an
// ink headline, and a cut.json title says which phrase that is.

export type TitleSegment = { text: string; accent: boolean };

const ACCENT = /\*([^*]+)\*/;

// Only the FIRST pair of asterisks is markup: a title carries at most one accent, and a stray
// asterisk further on stays a literal character instead of silently swallowing the rest.
export function parseAccent(title: string): TitleSegment[] {
  const found = title.match(ACCENT);
  if (!found || found.index === undefined) return [{ text: title, accent: false }];
  const before = title.slice(0, found.index);
  const after = title.slice(found.index + found[0].length);
  return [
    ...(before ? [{ text: before, accent: false }] : []),
    { text: found[1], accent: true },
    ...(after ? [{ text: after, accent: false }] : []),
  ];
}

export function plainTitle(title: string): string {
  return parseAccent(title)
    .map((segment) => segment.text)
    .join('');
}
