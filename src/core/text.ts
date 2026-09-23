// Small text helpers every module shares.

// A name as it appears in a file or a session name: lower case, anything but letters and digits as
// one dash (« iPhone SE (iOS 18) » → « iphone-se-ios-18- », the trailing dash included, which is
// what every state file of the bash engine was named with).
export function slug(s: string): string {
  return s
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[^a-z0-9\n]/gu, '-')
    .replace(/-+/g, '-');
}

// A comma list as written in a config (« Se connecter,Sign in »): trimmed items, empties dropped.
export function commaList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const pad = (n: number): string => String(n).padStart(2, '0');

// Local time with its offset, to the second: « 2026-09-23T21:04:05+02:00 », what meta.json has always held.
export function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

// « 21:04 » for an epoch in seconds: when a claim ends.
export function hhmm(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// « 2026-09-23 21:04 »: the stamp on a sheet's title.
export function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

