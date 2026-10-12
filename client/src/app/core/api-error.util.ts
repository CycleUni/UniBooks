import { I18nService } from './i18n.service';

/**
 * Turn an HttpErrorResponse into a sentence the user can read.
 *
 * The backend answers failures in two different shapes and a component that
 * knows only one of them shows "something went wrong" for errors that came
 * with a perfectly good explanation:
 *
 *   {"error": {"code": "listing.errBookShared"}}   hand-written views
 *   {"status": ["checkout.errListingUnavailable"]} DRF serializer validation
 *
 * Codes are looked up with tOrNull, never t: the backend can return a code no
 * locale declares (or plain English prose), and t() would echo the raw key
 * into the UI.
 */
export function parseApiError(err: any, i18n: I18nService, fallbackKey: string): string {
  return translateApiError(err, i18n) ?? i18n.t(fallbackKey);
}

/** The same lookup, but null rather than a fallback when the backend said
 *  nothing this locale can render — for the callers that have prose of their
 *  own to fall back to before the generic sentence. */
export function translateApiError(err: any, i18n: I18nService): string | null {
  const direct = i18n.tOrNull(err?.error?.error?.code);
  if (direct) return direct;

  const body = err?.error;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const value of Object.values(body)) {
      const hit = i18n.tOrNull(Array.isArray(value) ? value[0] : value);
      if (hit) return hit;
    }
  }

  return null;
}
