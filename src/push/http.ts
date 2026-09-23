// What the push drivers' fetch needs that curl did on its own. A url with credentials
// (`https://user:token@host/…`) is sent as Basic auth by curl, and refused outright by fetch (« Request
// cannot be constructed from a URL that includes credentials »); and fetch's own « fetch failed » says
// nothing, where its cause says what failed (ENOTFOUND, ECONNREFUSED, a certificate).

// The url without its credentials, and the headers with them as Basic auth, percent-decoded as curl
// sends them, unless the request already carries an Authorization.
export function withoutCredentials(url: string, headers: Record<string, string> = {}): { url: string; headers: Record<string, string> } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, headers };
  }
  if (!u.username && !u.password) return { url, headers };
  const basic = Buffer.from(`${decode(u.username)}:${decode(u.password)}`).toString('base64');
  u.username = '';
  u.password = '';
  const out = { ...headers };
  if (!Object.keys(out).some((k) => k.toLowerCase() === 'authorization')) out.Authorization = `Basic ${basic}`;
  return { url: u.href, headers: out };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// The url as a line may show it: its credentials, a token most of the time, replaced by `***`.
export function shownUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!u.username && !u.password) return url;
  return `${u.protocol}//***@${u.host}${u.pathname}${u.search}${u.hash}`;
}

// Why a request got no answer at all, in a few words.
export function fetchFailure(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string; errors?: Array<{ message?: string }> } };
  if (err?.name === 'TimeoutError') return 'no answer before the timeout';
  const cause = err?.cause;
  if (!cause) return err?.message || String(e);
  // Every address of a name refused (IPv6 then IPv4): an AggregateError with no message of its own.
  const message = cause.message || cause.errors?.map((x) => x.message).join(', ') || '';
  if (cause.code && !message.includes(cause.code)) return message ? `${cause.code}: ${message}` : cause.code;
  return message || err.message || 'fetch failed';
}
