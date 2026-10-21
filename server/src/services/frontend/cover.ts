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
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

/**
 * A floor for degenerate responses, not a guess at whether art exists.
 */
export const MIN_IMAGE_BYTES = 3000;

/**
 * Google serves its "image not available" card with `max-age=30`, and real
 * cover art with `max-age=86400`. It is saying the response is not durable,
 * which is exactly the question here, so that is what we read.
 */
export const DURABLE_MAX_AGE_SECONDS = 3600;

export function isPlaceholderResponse(response: Response): boolean {
  const cacheControl = response.headers.get('cache-control');
  if (!cacheControl) return false;
  const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match) return false;
  return parseInt(match[1], 10) < DURABLE_MAX_AGE_SECONDS;
}

/**
 * "No cover here", cached like a cover is.
 */
export const MISSING_COVER_MAX_AGE_SECONDS = 86400;

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
 * A found cover, kept for a year.
 */
export const COVER_MAX_AGE_SECONDS = 31536000;

/**
 * An upstream that failed (network error, 5xx) answers nothing about whether
 * the cover exists, so it is not cached as "missing" — but it is held for a
 * few seconds.
 */
export const UPSTREAM_ERROR_MAX_AGE_SECONDS = 10;

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
 */
export function coverResponse(body: Uint8Array, contentType: string): Response {
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

/**
 * Error indicating a transient failure from the upstream cover provider
 * (network error or HTTP 5xx response), distinct from "no cover exists".
 */
export class UpstreamError extends Error {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message ?? 'Upstream cover fetch failed');
    this.name = 'UpstreamError';
    if (options?.cause) (this as unknown as { cause: unknown }).cause = options.cause;
  }
}

export interface ValidatedCover {
  bytes: Uint8Array;
  contentType: string;
}

export interface FetchCoverOptions {
  /** Google Books zoom cascade start level (1..3). Defaults to URL zoom param or 1. */
  startZoom?: number;
}

/**
 * Shared function that fetches and validates a cover from external providers.
 * Applies allowed hosts (COVER_PROXY_HOSTS), protocol check, body size cap,
 * Google Books placeholder detection via cache-control max-age, minimum size,
 * zoom cascade (3→2→1 or from initial zoom), and image/* content type.
 *
 * Returns bytes + content type on success, null for "no cover" (404, placeholder,
 * degenerate response, invalid host/format), and throws UpstreamError on
 * transient upstream issues (network down or 5xx).
 */
export async function fetchAndValidateCover(
  src: string,
  fetcher: (url: string) => Promise<Response>,
  options?: FetchCoverOptions,
): Promise<ValidatedCover | null> {
  let srcUrl: URL;
  try {
    srcUrl = new URL(src);
    if (srcUrl.protocol !== 'http:' && srcUrl.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }

  if (!COVER_PROXY_HOSTS.includes(srcUrl.hostname)) {
    return null;
  }

  if (srcUrl.hostname === 'covers.openlibrary.org' || srcUrl.hostname === 'pdsapp.ncl.edu.tw') {
    const upstreamUrl = new URL(srcUrl.toString());
    if (upstreamUrl.hostname === 'covers.openlibrary.org') {
      upstreamUrl.searchParams.set('default', 'false');
    }
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetcher(upstreamUrl.toString());
    } catch (e) {
      throw new UpstreamError('Upstream network failure', { cause: e });
    }

    if (!upstreamResponse.ok) {
      if (upstreamResponse.status >= 500) {
        throw new UpstreamError(`Upstream returned ${upstreamResponse.status}`);
      }
      return null;
    }

    const bytes = await readCapped(upstreamResponse, MAX_COVER_BYTES);
    if (!bytes || bytes.byteLength < 100) {
      return null;
    }

    const contentType = upstreamResponse.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) return null;
    return { bytes, contentType };
  }

  let initialZoom = 1;
  if (options?.startZoom !== undefined) {
    initialZoom = Math.min(Math.max(options.startZoom, 1), 3);
  } else {
    const zoomParam = srcUrl.searchParams.get('zoom');
    if (zoomParam) {
      const parsed = parseInt(zoomParam, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        initialZoom = Math.min(parsed, 3);
      }
    }
  }

  let transientFailure = false;
  for (let currentZoom = initialZoom; currentZoom >= 1; currentZoom--) {
    const targetUrl = new URL(srcUrl.toString());
    targetUrl.searchParams.set('zoom', currentZoom.toString());

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetcher(targetUrl.toString());
    } catch {
      transientFailure = true;
      continue;
    }

    if (!upstreamResponse.ok) {
      if (upstreamResponse.status >= 500) transientFailure = true;
      continue;
    }

    if (isPlaceholderResponse(upstreamResponse)) {
      continue;
    }

    const bytes = await readCapped(upstreamResponse, MAX_COVER_BYTES);
    if (bytes && bytes.byteLength >= MIN_IMAGE_BYTES) {
      const contentType = upstreamResponse.headers.get('content-type') || 'image/jpeg';
      if (!contentType.toLowerCase().startsWith('image/')) continue;
      return { bytes, contentType };
    }
  }

  if (transientFailure) {
    throw new UpstreamError('Upstream failure during zoom cascade');
  }

  return null;
}

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

  try {
    const validated = await fetchAndValidateCover(src, deps.fetch);
    if (!validated) {
      return missingCover(request, deps);
    }
    return cached(request, deps, coverResponse(validated.bytes, validated.contentType));
  } catch (e) {
    if (e instanceof UpstreamError) {
      return upstreamError(request, deps);
    }
    throw e;
  }
}
