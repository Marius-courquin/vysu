// Which control a flow's `click "<label>"` means. A label names one control, exactly: the accessible
// name or the text as it reads, whatever its case and its spacing, never a part of it. A substring
// match clicked « Passer en cours » for a `click "Passer"` and moved a real incident (#311) to
// IN_PROGRESS on prep, then « Valider et passer au suivant » (2026-09-30, R109). `--partial` is the
// opt-in for the old reading, the first control whose name holds the label.

export interface Ref {
  ref: string;
  role: string;
  name: string;
}

// What a name is compared as. An icon drawn as a glyph — an emoji, an icon font's private-use code
// point — at either end is no part of what a reader calls the control.
const EDGE_GLYPHS = /^[\p{So}\p{Co}\s]+|[\p{So}\p{Co}\s]+$/gu;
// A typographic apostrophe is the same letter as a typed one: French copy writes « l’accueil », a flow
// « l'accueil ».
const APOSTROPHES = /[\u2018\u2019\u02bc`]/g;
export function normName(s: string): string {
  return s.normalize('NFC').replace(EDGE_GLYPHS, '').replace(APOSTROPHES, "'").replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

// The refs of an `agent-browser snapshot -i --json`, in the order of the page: agent-browser numbers
// them as it walks the tree, and the JSON object lists them e1, e10, e11, e2.
export function refsOf(snapshotJson: string): Ref[] {
  let refs: Record<string, { role?: string; name?: string }> = {};
  try {
    const d = JSON.parse(snapshotJson) as { data?: { refs?: typeof refs } };
    refs = d.data?.refs ?? {};
  } catch {
    return [];
  }
  return Object.entries(refs)
    .filter(([ref]) => /^e[0-9]+$/.test(ref))
    .map(([ref, r]) => ({ ref, role: r.role ?? '', name: r.name ?? '' }))
    .sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));
}

// The control named exactly so: by role in the order given (a button before a link before a switch…),
// then any other element the snapshot names (a clickable card, a row), each in the order of the page.
export function exactRef(refs: Ref[], label: string, roles: string[]): Ref | undefined {
  const want = normName(label);
  if (!want) return undefined;
  const named = refs.filter((r) => normName(r.name) === want);
  for (const role of roles) {
    const hit = named.find((r) => r.role === role);
    if (hit) return hit;
  }
  return named[0];
}

// Edit distance, for a label typed with a slip.
export function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length]!;
}

// What the label was probably meant to be, at most `max` names: the controls whose name holds it (what
// a substring match would have clicked), then those it holds, then the ones a slip away. A container
// whose name is a whole paragraph is nobody's label.
export function nearNames(refs: Ref[], label: string, roles: string[], max = 3): string[] {
  const want = normName(label);
  if (!want) return [];
  const seen = new Set<string>();
  const scored: Array<{ name: string; score: number; at: number }> = [];
  refs.forEach((r, at) => {
    const n = normName(r.name);
    if (!n || n.length > 80 || seen.has(n)) return;
    if (!roles.includes(r.role) && r.role !== 'generic') return;
    let score = -1;
    if (n.includes(want)) score = 0;
    else if (want.includes(n) && n.length >= 3) score = 1;
    else {
      const d = distance(n, want);
      if (d <= Math.max(2, Math.floor(want.length / 4))) score = 2 + d;
    }
    if (score < 0) return;
    seen.add(n);
    scored.push({ name: r.name.trim(), score, at });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .slice(0, max)
    .map((s) => s.name);
}

// `click "<label>" [--partial]`: the label, and whether a part of a name will do.
export function clickWords(words: string[]): { label: string; partial: boolean } {
  const partial = words.includes('--partial');
  return { label: words.find((w) => w !== '--partial') ?? '', partial };
}

// The text tier: an element of the page whose own text is the label, for a label that is the words
// beside a control rather than its name (a card's title, a row). Marked, so agent-browser clicks it as
// it clicks anything else (scrolled into view, waited for); the answer is how many matched. The same
// comparison as normName, run in the page.
export const CLICK_MARK = 'data-vysu-click';
export function markTextJs(label: string): string {
  return `(() => {
  const norm = s => s.normalize("NFC").replace(${EDGE_GLYPHS.toString()}, "").replace(${APOSTROPHES.toString()}, "'").replace(/\\s+/g, " ").trim().toLocaleLowerCase();
  const want = norm(${JSON.stringify(label)});
  document.querySelectorAll("[${CLICK_MARK}]").forEach(e => e.removeAttribute("${CLICK_MARK}"));
  if (!want) return 0;
  const hits = [...document.querySelectorAll("body *")].filter(e => e.getClientRects().length && norm(e.textContent || "") === want && ![...e.children].some(c => norm(c.textContent || "") === want));
  if (hits[0]) hits[0].setAttribute("${CLICK_MARK}", "");
  return hits.length;
})()`;
}
