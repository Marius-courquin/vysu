// The spellings agents reach for first, read as the command they meant. agent-browser drops a verb it
// does not know and reports the next word instead (« Unknown command: 390 »), so `vysu <persona>
// viewport 390 844` said nothing about viewports: 45 calls of the audit (25/09 → 12/10) were
// `viewport` / `resize` (agent-browser's is `set viewport <w> <h>`) or a flow's `go` / `nav` typed on
// the passthrough (agent-browser's is `open`).
export function browserAlias(args: string[]): string[] {
  const [verb, ...rest] = args;
  if ((verb === 'viewport' || verb === 'resize') && rest.length) {
    const size = /^(\d+)x(\d+)$/.exec(rest[0]!);
    if (size) return ['set', 'viewport', size[1]!, size[2]!, ...rest.slice(1)];
    if (/^\d+$/.test(rest[0]!)) return ['set', 'viewport', ...rest];
  }
  if ((verb === 'go' || verb === 'nav') && rest.length) return ['open', ...rest];
  return args;
}
