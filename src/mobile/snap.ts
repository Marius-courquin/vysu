// What a snapshot's nodes say, read from agent-device's JSON rather than grepped out of its text: the
// launcher, the dev menu, a red box, the ready text. Each test states the text form it replaces.
export interface SnapNode {
  type?: string;
  label?: string;
  value?: string;
  identifier?: string;
  depth?: number;
  selected?: boolean;
  enabled?: boolean;
  interactionBlocked?: string;
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
