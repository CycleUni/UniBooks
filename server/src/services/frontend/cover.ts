import { readCapped } from '../../lib/body';
import { COVER_PROXY_HOSTS } from '../catalog/common';
/**
 * The /api/cover proxy (src/routes/frontend.ts). Written against plain
 * Request/Response with the edge cache, fetch and waitUntil passed in, like
 * bookMeta.ts, so the tests can drive it with stubs.
 */
export interface CoverDeps {
  cache: Pick<Cache, 'match' | 'put'>;
  fetch: (url: string) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Runs on a cache miss, before any upstream fetch (the route's rate limit): edge-cache hits stay free. */
  onMiss?: () => Promise<void>;
}

/** Larger than any real cover; a bigger upstream body is not buffered. */
const MAX_COVER_BYTES = 5 * 1024 * 1024;

/** The upstream body, or null when it is over MAX_COVER_BYTES. */
async function upstreamBody(res: Response): Promise<ArrayBuffer | null> {
  const bytes = await readCapped(res, MAX_COVER_BYTES);
  return bytes ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) : null;
}

/**
 * A floor for degenerate responses, not a guess at whether art exists.
 *
 * This replaces per-zoom thresholds of 5,000 / 13,000 / 20,000 bytes, which
 * were trying to answer "is there a cover here?" by weight and got it wrong in
 * both directions. Measured across 13 volumes: a real cover at zoom 2 came in
 * at 12,934 bytes and was rejected for being 66 bytes light, so the page fell
 * back to the zoom 1 image; another at 10,626 was rejected at zoom 2 and its
 * zoom 1 at 4,786 was rejected too, leaving that book with no cover at all.
 * Whether art exists is now cache-control's answer (see below).
 *
 * What weight still catches is Google occasionally returning a blank sliver —
 * one volume answers zoom 2 with a 300x48 white bar of 1,026 bytes, marked
 * durable. The smallest real cover measured was 4,786 bytes and the largest
 * sliver 1,491, so the floor sits between them with room on both sides.
 */
const MIN_IMAGE_BYTES = 3000;

/**
 * Google serves its "image not available" card with `max-age=30`, and real
 * cover art with `max-age=86400`. It is saying the response is not durable,
 * which is exactly the question here, so that is what we read.
 *
 * Byte size cannot answer it. The placeholder rendered at zoom 2 is 15,567
 * bytes — larger than that zoom's threshold, so it was accepted, and the
 * cascade stopped before reaching a zoom that had the real jacket. Raising the
 * threshold past it is not available either: of ten real covers measured at
 * zoom 2, two are smaller than the placeholder (10,626 and 12,934 bytes).
 * Content type does not separate them either — the placeholder is a PNG, but
 * so is a real line-art cover measured at 86,631 bytes.
 *
 * Checked against 39 responses (13 volumes x 3 zooms): every placeholder said
 * 30, every real cover 86400, including the volume that has real art at zoom 1
 * and the placeholder above it. The cutoff sits between the two by an order of
 * magnitude on either side, so a change to Google's exact numbers has room
 * before it reverses the decision.
 */
const DURABLE_MAX_AGE_SECONDS = 3600;

function isPlaceholderResponse(response: Response): boolean {
  const cacheControl = response.headers.get('cache-control');
  if (!cacheControl) return false;
  const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match) return false;
  return parseInt(match[1], 10) < DURABLE_MAX_AGE_SECONDS;
}

/**
 * "No cover here", cached like a cover is. It used to go out bare — no
 * Cache-Control, never put in the edge cache — so every view of a book with
 * no jacket re-ran this handler and up to three upstream fetches, and a page
 * that kept re-requesting the image (see UiRecentListings.gridItems) spent a
 * billed Worker request on each try. A day is long enough to stop that and
 * short enough for a cover added upstream to appear.
 */
const MISSING_COVER_MAX_AGE_SECONDS = 86400;

function missingCover(request: Request, deps: CoverDeps): Response {
  return cached(
    request,
    deps,
    new Response(null, {
      status: 404,
      headers: { 'Cache-Control': `public, max-age=${MISSING_COVER_MAX_AGE_SECONDS}` },
    }),
  );
}

/**
 * A found cover, kept for a year. A cover is addressed by its upstream URL,
 * which names one edition's jacket, so the image behind a key does not
 * change; the Cache API may still evict a rarely read entry earlier, which
 * only costs a fresh lookup.
 */
const COVER_MAX_AGE_SECONDS = 31536000;

/**
 * An upstream that failed (network error, 5xx) answers nothing about whether
 * the cover exists, so it is not cached as "missing" — but it is held for a
 * few seconds. Uncached, every page asking for that cover while the upstream
 * was down ran this handler and the upstream fetches again, the same storm
 * a missing cover used to cause.
 */
const UPSTREAM_ERROR_MAX_AGE_SECONDS = 10;

function upstreamError(request: Request, deps: CoverDeps): Response {
  return cached(
    request,
    deps,
    new Response(null, {
      status: 502,
      headers: { 'Cache-Control': `public, max-age=${UPSTREAM_ERROR_MAX_AGE_SECONDS}` },
    }),
  );
}

/**
 * The cover to serve, or null when the upstream did not answer with an image.
 *
 * Served from this site's own origin and cached for a year, so it must never
 * be anything a browser would run: an allowlisted host answering some path
 * with HTML would otherwise have been served as HTML from unibooks.app. The
 * assets' _headers do not apply to the Worker's own responses, hence the
 * headers here.
 */
function coverResponse(body: ArrayBuffer, upstream: Response): Response | null {
  const contentType = upstream.headers.get('content-type') || 'image/jpeg';
  if (!contentType.toLowerCase().startsWith('image/')) return null;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${COVER_MAX_AGE_SECONDS}, immutable`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

/** Store `response` in the edge cache under `request`, and return it. */
function cached(request: Request, deps: CoverDeps, response: Response): Response {
  deps.waitUntil(deps.cache.put(request, response.clone()));
  return response;
}

// Cache-Control on the returned Response only governs the *browser's* cache.
// Cloudflare's edge/CDN cache does not automatically store dynamic
// Worker responses just because a Cache-Control header is present —
// that has to be opted into explicitly via the Cache API — deps.cache, which
// is caches.default (see src/routes/frontend.ts). Without it, every request
// for the same book cover (from any visitor, anywhere) would re-run the
// zoom-cascade/size-check logic and re-fetch from Google/Open Library every
// single time, instead of being served instantly from Cloudflare's edge
// after the first successful lookup.
export async function handleCover(request: Request, deps: CoverDeps): Promise<Response> {
  const requestUrl = new URL(request.url);
  const src = requestUrl.searchParams.get('src');

  if (!src) {
    return new Response('Missing required "src" query parameter', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // Cached under src alone. Keyed on the whole URL, any extra parameter
  // (&x=<random>) missed the cache and re-ran up to three upstream fetches.
  request = new Request(`${requestUrl.origin}${requestUrl.pathname}?src=${encodeURIComponent(src)}`);

  const hit = await deps.cache.match(request);
  if (hit) {
    return hit;
  }
  await deps.onMiss?.();

  let srcUrl: URL;
  try {
    srcUrl = new URL(src);
    if (srcUrl.protocol !== 'http:' && srcUrl.protocol !== 'https:') {
      return new Response('Invalid "src" query parameter: protocol must be http or https', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }
  } catch {
    return new Response('Invalid "src" query parameter: malformed URL', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  if (!COVER_PROXY_HOSTS.includes(srcUrl.hostname)) {
    return new Response('Invalid "src" query parameter: unsupported host', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  if (srcUrl.hostname === 'covers.openlibrary.org' || srcUrl.hostname === 'pdsapp.ncl.edu.tw') {
    // Open Library answers a missing cover with a 43-byte blank GIF and a
    // 200 unless asked not to; default=false makes it a plain 404.
    const upstreamUrl = new URL(srcUrl.toString());
    if (upstreamUrl.hostname === 'covers.openlibrary.org') {
      upstreamUrl.searchParams.set('default', 'false');
    }
    try {
      const upstreamResponse = await deps.fetch(upstreamUrl.toString());
      if (!upstreamResponse.ok) {
        return upstreamResponse.status >= 500 ? upstreamError(request, deps) : missingCover(request, deps);
      }

      const bodyBuffer = await upstreamBody(upstreamResponse);
      if (!bodyBuffer || bodyBuffer.byteLength < 100) {
        return missingCover(request, deps);
      }

      const response = coverResponse(bodyBuffer, upstreamResponse);
      if (!response) return missingCover(request, deps);
      return cached(request, deps, response);
    } catch {
      // A network failure says nothing about whether the cover exists, so it
      // is only held briefly — see upstreamError.
      return upstreamError(request, deps);
    }
  }

  const zoomParam = srcUrl.searchParams.get('zoom');
  let initialZoom = 1;
  if (zoomParam) {
    const parsed = parseInt(zoomParam, 10);
    if (!isNaN(parsed) && parsed >= 1) {
      initialZoom = Math.min(parsed, 3);
    }
  }

  // Set when an attempt failed for a reason that says nothing about the
  // cover (network error, upstream 5xx), so that "missing" is not cached.
  let transientFailure = false;
  for (let currentZoom = initialZoom; currentZoom >= 1; currentZoom--) {
    const targetUrl = new URL(srcUrl.toString());
    targetUrl.searchParams.set('zoom', currentZoom.toString());

    try {
      const upstreamResponse = await deps.fetch(targetUrl.toString());
      if (!upstreamResponse.ok) {
        if (upstreamResponse.status >= 500) transientFailure = true;
        continue;
      }

      // Before measuring anything: a 200 here can still be the "image not
      // available" card, and it can outweigh any size floor.
      if (isPlaceholderResponse(upstreamResponse)) {
        continue;
      }

      const bodyBuffer = await upstreamBody(upstreamResponse);
      if (bodyBuffer && bodyBuffer.byteLength >= MIN_IMAGE_BYTES) {
        const response = coverResponse(bodyBuffer, upstreamResponse);
        if (!response) continue;
        return cached(request, deps, response);
      }
    } catch {
      transientFailure = true;
      continue;
    }
  }

  return transientFailure ? upstreamError(request, deps) : missingCover(request, deps);
}
