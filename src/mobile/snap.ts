// What a snapshot's nodes say, read from agent-device's JSON rather than grepped out of its text: the
// launcher, the dev menu, a red box, the ready text. Each test states the text form it replaces.
export interface SnapNode {
  index?: number;
  parentIndex?: number;
  type?: string;
  label?: string;
  value?: string;
  identifier?: string;
  depth?: number;
  selected?: boolean;
  enabled?: boolean;
  hittable?: boolean;
  interactionBlocked?: string;
  presentationHints?: string[] | string;
  inheritsLabel?: boolean;
  rect?: { x?: number; y?: number; width?: number; height?: number };
}

export function nodesOf(data: Record<string, unknown>): SnapNode[] {
  const n = data.nodes;
  return Array.isArray(n) ? (n as SnapNode[]) : [];
}

const texts = (n: SnapNode): string[] => [n.label ?? '', n.value ?? ''].filter(Boolean);

// A label shown as `"<text>"`, the whole of it.
export const hasExact = (nodes: SnapNode[], text: string): boolean => nodes.some((n) => texts(n).includes(text));
// A text anywhere on screen.
export const hasPart = (nodes: SnapNode[], re: RegExp): boolean => nodes.some((n) => texts(n).some((t) => re.test(t)));

// `[button]` in the text form, whatever the platform calls it (Button, android.widget.Button…).
export const isButton = (n: SnapNode): boolean => /button/i.test((n.type ?? '').split('.').pop() ?? '');
const kindOf = (n: SnapNode): string => (n.type ?? '').split('.').pop()!.toLowerCase();

// Expo's launcher (« Development Build » and its server list) or its error page (« There was a
// problem loading the project »: the load timed out on a busy Mac, or Metro was down): either way the
// app never got its bundle, and handing it the URL again is the fix for both.
export const onLauncher = (nodes: SnapNode[]): boolean =>
  hasExact(nodes, 'Development Build') || hasPart(nodes, /There was a problem loading the project/);

// Expo's dev menu and its first-run intro.
export const onDevMenu = (nodes: SnapNode[]): boolean => hasPart(nodes, /Runtime version|This is the developer menu/);

// React Native's red box: a JS error the app cannot render past. Nothing will get ready behind it,
// and its first line is what the agent needs to read. Its two buttons, together: « DISMISS (ESC) »
// and « RELOAD (R, R) » (the label may break a line).
export function redbox(nodes: SnapNode[]): boolean {
  const b = nodes.filter(isButton).map((n) => n.label ?? '');
  return b.some((l) => /^(DISMISS|Dismiss)/.test(l)) && b.some((l) => /^(RELOAD|Reload)/.test(l));
}
export function redboxMessage(nodes: SnapNode[]): string {
  for (const n of nodes) {
    const l = n.label ?? '';
    if (!/^[^"]{25,}/.test(l) || /^(DISMISS|Dismiss|RELOAD|Reload)/.test(l)) continue;
    return l.slice(0, 160);
  }
  return '';
}

// An iOS system alert, by its own text on an [alert] node: an app button that merely says « Ouvrir »
// must never be pressed for it.
export const alertStarting = (nodes: SnapNode[], starts: string[]): boolean =>
  nodes.some((n) => kindOf(n) === 'alert' && starts.some((s) => (n.label ?? '').startsWith(s)));

// What is on screen, reduced to one string: the tree before a link against the tree after it.
export function signature(nodes: SnapNode[]): string {
  return JSON.stringify(nodes.map((n) => [n.depth, n.type, n.label, n.value, n.identifier, n.selected, n.enabled, n.interactionBlocked]));
}

// --- Android's « <app> ne répond pas » -------------------------------------------------------------

// An ANR dialog over the app (« Fermer l'application » / « Attendre », en « Close app » / « Wait »):
// on a loaded machine the app, Chrome's Custom Tab or the system UI miss an input deadline, and the
// dialog then sits over everything a login or a step looks for. Seen in the audit of 2026-10-12: an
// mlogin that said « not on the door screen » with nothing on screen but those two buttons. Waiting is
// always the answer (closing the app would end the login it is in the middle of).
const ANR_WAIT = ['attendre', 'wait'];
const ANR_CLOSE = ["fermer l'application", "fermer l’application", 'close app'];
const lower = (s: string | undefined): string => (s ?? '').trim().toLocaleLowerCase('fr');
export function anrWait(nodes: SnapNode[]): SnapNode | null {
  if (!nodes.some((n) => ANR_CLOSE.includes(lower(n.label)))) return null;
  return nodes.find((n) => ANR_WAIT.includes(lower(n.label)) && boxOf(n)) ?? null;
}
// The package that is not responding, read from `dumpsys window`: the focused window is then
// « Application Not Responding: <package> ». '' when none is.
export function anrPackage(dumpsysWindow: string): string {
  const focus = dumpsysWindow.split('\n').find((l) => l.includes('mCurrentFocus')) ?? '';
  return /Application Not Responding: ([\w.]+)/.exec(focus)?.[1] ?? '';
}
// The browsers holding a Custom Tab, read from `dumpsys activity activities`: a login that failed
// halfway leaves Auth0's page open over the app, and the next login's door is then under it.
export function customTabPackages(dumpsysActivities: string): string[] {
  const out = new Set<string>();
  for (const m of dumpsysActivities.matchAll(/ActivityRecord\{[^}]*? ([\w.]+)\/[\w.]*CustomTabActivity/g)) out.add(m[1]!);
  return [...out];
}

// --- what a tap by label presses ------------------------------------------------------------------

type Box = { x: number; y: number; w: number; h: number };
function boxOf(n: SnapNode): Box | null {
  const r = n.rect;
  if (!r || typeof r.x !== 'number' || typeof r.y !== 'number' || typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}
const inside = (b: Box, x: number, y: number): boolean => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
const area = (b: Box): number => b.w * b.h;
const coveredHint = (n: SnapNode): boolean =>
  Array.isArray(n.presentationHints) ? n.presentationHints.includes('covered') : typeof n.presentationHints === 'string' && n.presentationHints.includes('covered');

// A label as agent-device's selectors compare it (case and runs of spaces aside), with one kind of
// apostrophe: a French label is typed with ' and drawn with ’.
export const tapNorm = (s: string): string => s.trim().toLowerCase().replaceAll('’', "'").replace(/\s+/g, ' ');

export type TapTarget =
  // Pressed there: the centre of the node that carries the text, else a point of it nothing inside covers.
  // `alone`: the one node on screen carrying that very label, pressed at its centre: a selector names it
  // as well as the point does.
  | { kind: 'hit'; x: number; y: number; label: string; note: string; alone?: boolean }
  // Matched, but under a bar, a sheet or the keyboard, or laid out off the screen.
  | { kind: 'hidden'; label: string }
  // Nothing carries that label; `holders`: the labels that hold it within them, for the miss.
  | { kind: 'none'; holders: string[] };

// What `tap "<label>"` presses. A card is one pressable whose label is all its texts, and its centre
// is wherever the layout put it: on a loan card, a discussion with photos, the photo, which opens the
// viewer instead of the detail (11 checker reports, 2026-09/10: « taper le libellé de la carte ouvre la
// visionneuse »). So among the nodes carrying the label exactly (case and spaces aside; anywhere in it
// with `partial`), the smallest is pressed, the text itself rather than what encloses it; and when
// that is still a container (iOS merges a card's texts into the card), it is pressed where nothing
// inside it takes the touch for itself: an image, a scroller, a button, a labelled part of its own.
// A child that repeats its ancestor's long label carries it too (agent-device prints it as
// `inheritsLabel`).
export function tapTarget(nodes: SnapNode[], label: string, partial = false): TapTarget {
  const want = tapNorm(label);
  const byIndex = new Map<number, SnapNode>();
  for (const n of nodes) if (typeof n.index === 'number') byIndex.set(n.index, n);
  const parent = (n: SnapNode): SnapNode | undefined => (typeof n.parentIndex === 'number' ? byIndex.get(n.parentIndex) : undefined);
  const labelOf = (n: SnapNode): string => {
    if (n.label) return n.label;
    if (!n.inheritsLabel) return '';
    for (let a = parent(n); a; a = parent(a)) if (a.label) return a.label;
    return '';
  };
  const texts = (n: SnapNode): string[] => [labelOf(n), n.value ?? '', n.identifier ?? ''].filter(Boolean).map(tapNorm);
  const is = (t: string): boolean => (partial ? t.includes(want) : t === want);
  const descends = (n: SnapNode, from: SnapNode): boolean => {
    for (let a = parent(n); a; a = parent(a)) if (a === from) return true;
    return false;
  };
  if (!want) return { kind: 'none', holders: [] };
  // The screen: the windows' boxes (depth 0), as the screen line reads it. Keyboard keys cover what
  // lies under them: agent-device refuses a press there, and the agent's fix is a `key dismiss`.
  const roots = nodes.filter((n) => !n.depth).map(boxOf).filter((b): b is Box => !!b);
  const vp = roots.length ? roots : nodes.map(boxOf).filter((b): b is Box => !!b);
  const onScreen = (x: number, y: number): boolean => vp.some((b) => inside(b, x, y));
  const keyboard = nodes.filter((n) => /keyboard/i.test((n.type ?? '').split('.').pop() ?? '')).map(boxOf).filter((b): b is Box => !!b);
  const reachable = (x: number, y: number): boolean => onScreen(x, y) && !keyboard.some((k) => inside(k, x, y));

  const matched = nodes.filter((n) => boxOf(n) && texts(n).some(is));
  if (!matched.length) {
    const holders: string[] = [];
    for (const n of nodes) {
      const l = labelOf(n);
      if (l && tapNorm(l).includes(want) && boxOf(n) && !holders.includes(l)) holders.push(l);
    }
    return { kind: 'none', holders: holders.slice(0, 3) };
  }
  const open = matched.filter((n) => {
    const b = boxOf(n)!;
    return !coveredHint(n) && !n.interactionBlocked && reachable(b.x + b.w / 2, b.y + b.h / 2);
  });
  if (!open.length) return { kind: 'hidden', label: labelOf(matched[0]!) || matched[0]!.value || label };
  // The smallest wins; on a tie, the first in the tree.
  let pick = open[0]!;
  for (const n of open) if (area(boxOf(n)!) < area(boxOf(pick)!)) pick = n;
  const b = boxOf(pick)!;
  const shown = labelOf(pick) || pick.value || label;
  const kids = nodes.filter((n) => n !== pick && boxOf(n) && descends(n, pick));
  const own = tapNorm(shown);
  const takesTouch = (n: SnapNode): boolean => {
    const t = ((n.type ?? '').split('.').pop() ?? '').toLowerCase();
    if (/image|scroll|recycler|collection|button|switch|slider|textfield|edittext|link/.test(t)) return true;
    const l = tapNorm(labelOf(n));
    return t === 'other' && !!l && !own.includes(l);
  };
  const blockers = kids.filter(takesTouch).map(boxOf) as Box[];
  const free = (x: number, y: number): boolean => reachable(x, y) && !blockers.some((k) => inside(k, x, y));
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (free(cx, cy)) {
    const alone = open.length === 1 && matched.length === 1 && tapNorm(labelOf(pick)) === want;
    return { kind: 'hit', x: Math.round(cx), y: Math.round(cy), label: shown, note: '', ...(alone ? { alone } : {}) };
  }
  // A text of its own inside it, the widest first (the title, the description), else a point of it
  // nothing covers, scanned from the middle out.
  const textKids = kids
    .filter((n) => /text|label|heading/i.test((n.type ?? '').split('.').pop() ?? '') || (!!labelOf(n) && !takesTouch(n)))
    .filter((n) => {
      const k = boxOf(n)!;
      return free(k.x + k.w / 2, k.y + k.h / 2);
    })
    .sort((m, n) => area(boxOf(n)!) - area(boxOf(m)!));
  if (textKids[0]) {
    const k = boxOf(textKids[0])!;
    const t = labelOf(textKids[0]) || textKids[0].value || '';
    return { kind: 'hit', x: Math.round(k.x + k.w / 2), y: Math.round(k.y + k.h / 2), label: shown, note: t ? `on its text « ${t} »` : 'on its text' };
  }
  for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
    for (const fx of [0.5, 0.25, 0.75]) {
      const x = b.x + b.w * fx;
      const y = b.y + b.h * fy;
      if (free(x, y)) return { kind: 'hit', x: Math.round(x), y: Math.round(y), label: shown, note: 'beside what covers its centre' };
    }
  }
  return { kind: 'hit', x: Math.round(cx), y: Math.round(cy), label: shown, note: '' };
}

// --- the iOS keyboard put away ---------------------------------------------------------------------

// Where a tap puts the iOS keyboard away when it has no key of its own to do it (a numeric pad, an
// e-mail field with no « Done »): agent-device refuses a background tap on principle, and 14 `key
// dismiss` steps ended there in the audit. A plain text above the keyboard, outside anything that takes
// a touch (a button, a link, a field, an image, a key), the topmost first: a title or a form label,
// which a scroll view answers by resigning the field. null when there is no keyboard or no such text.
export function keyboardFreeSpot(nodes: SnapNode[]): { x: number; y: number; label: string } | null {
  const kind = (n: SnapNode): string => ((n.type ?? '').split('.').pop() ?? '').toLowerCase();
  const kb = nodes.filter((n) => kind(n) === 'keyboard').map(boxOf).filter((b): b is Box => !!b);
  if (!kb.length) return null;
  const top = Math.min(...kb.map((b) => b.y));
  const touch = nodes
    .filter((n) => /button|link|textfield|textview|searchfield|switch|slider|tab|key|image|picker|segmented/.test(kind(n)))
    .map(boxOf)
    .filter((b): b is Box => !!b);
  const spots = nodes
    .filter((n) => /statictext|heading/.test(kind(n)) && !n.interactionBlocked && !coveredHint(n) && (n.label ?? '').trim())
    .map((n) => ({ n, b: boxOf(n) }))
    .filter((s): s is { n: SnapNode; b: Box } => !!s.b)
    .map(({ n, b }) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2), label: n.label! }))
    .filter((s) => s.y > 0 && s.y < top && !touch.some((t) => inside(t, s.x, s.y)))
    .sort((a, b) => a.y - b.y);
  return spots[0] ?? null;
}
export const keyboardUp = (nodes: SnapNode[]): boolean => nodes.some((n) => ((n.type ?? '').split('.').pop() ?? '').toLowerCase() === 'keyboard');
