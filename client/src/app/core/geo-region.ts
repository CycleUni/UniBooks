/** IP-based region detection for a first visit.
 *
 * Two independent sources, both answered from the visitor's IP by Cloudflare:
 *
 * 1. The backend's /core/geo/, which reads the CDN's country header. It is
 *    the primary: the header name is a backend setting, so it survives a
 *    move of the API to another CDN.
 * 2. /cdn-cgi/trace on this site's own origin, served by Cloudflare Pages.
 *    The backup for when the API's proxy is switched off or the API is down.
 *    It is a documented Cloudflare troubleshooting endpoint, but plain text
 *    with no versioned format, so it is parsed defensively and never trusted
 *    alone over the backend.
 *
 * Both start together so a failing backend costs no extra round trip, and the
 * whole lookup is capped: a first visit waits at most `timeoutMs` before the
 * caller falls back to the timezone guess.
 */

export interface GeoSources {
  /** The backend's answer: an upper-case region code, or null. */
  backend: () => Promise<string | null>;
  /** The raw /cdn-cgi/trace body, or null. */
  trace: () => Promise<string | null>;
}

/**
 * The region a browser timezone settles without asking the IP, or null.
 *
 * Only the two timezones that name one region outright. A first visit from
 * either used to wait (up to the lookup's cap) for IP detection before the
 * entry redirect, almost always to be told the same thing — on a slow phone
 * link a visible delay before anything rendered. Every other timezone still
 * waits for the IP, which the timezone alone cannot place.
 */
export function regionFromTimezone(timeZone: string | null | undefined): 'tw' | 'hk' | null {
  switch (timeZone) {
    case 'Asia/Taipei':
      return 'tw';
    case 'Asia/Hong_Kong':
      return 'hk';
    default:
      return null;
  }
}

/** `loc=HK` out of a /cdn-cgi/trace body, upper-cased, or null. */
export function parseTraceCountry(body: string | null | undefined): string | null {
  const match = /^loc=([A-Za-z]{2})\s*$/m.exec(body || '');
  return match ? match[1].toUpperCase() : null;
}

/** GET /cdn-cgi/trace on this origin, or null when it is not there (local dev, another host). */
export async function fetchTrace(signal?: AbortSignal): Promise<string | null> {
  if (typeof fetch === 'undefined') return null;
  try {
    const res = await fetch('/cdn-cgi/trace', { cache: 'no-store', credentials: 'omit', signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * The region the visitor's IP places them in, lower-cased, or null.
 *
 * The backend wins when it has an answer, and is taken as given: it has
 * already matched the country against the active regions, which is the
 * authoritative list — `isKnown` may not have it yet on a first load, and
 * checking against its fallback would throw away a newly added region. The
 * trace is only a country, so it must pass `isKnown`.
 */
export async function detectRegion(
  sources: GeoSources,
  isKnown: (code: string) => boolean,
  timeoutMs: number,
): Promise<string | null> {
  const normalize = (code: string | null | undefined): string | null => {
    const lower = (code || '').toLowerCase();
    return /^[a-z]{2}$/.test(lower) ? lower : null;
  };

  const backend = sources.backend().catch(() => null);
  const trace = sources.trace().catch(() => null);

  const lookup = (async () => {
    const fromBackend = normalize(await backend);
    if (fromBackend) return fromBackend;
    const fromTrace = normalize(parseTraceCountry(await trace));
    return fromTrace && isKnown(fromTrace) ? fromTrace : null;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
