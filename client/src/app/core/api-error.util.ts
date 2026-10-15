import { I18nService } from './i18n.service';

/**
 * Turn an HttpErrorResponse into a sentence the user can read.
 *
 * Every API failure has one shape, and a component that reads it by hand
 * tends to forget half of it:
 *
 *   {"error": {"code": "listing.errBookShared", ...extra}}
 *   {"error": {"code": "common.errValidation", "fields": {"status": ["checkout.errListingUnavailable"]}}}
 *
 * A field's code is the more specific sentence, so it wins over the
 * top-level code ("common.errValidation" only says something is wrong).
 * Codes are looked up with tOrNull, never t: the backend can return a code no
 * locale declares, and t() would echo the raw key into the UI.
 */
export function parseApiError(err: any, i18n: I18nService, fallbackKey: string): string {
  return translateApiError(err, i18n) ?? i18n.t(fallbackKey);
}

/** The same lookup, but null rather than a fallback when the backend said
 *  nothing this locale can render — for the callers that have prose of their
 *  own to fall back to before the generic sentence. */
export function translateApiError(err: any, i18n: I18nService): string | null {
  const body = err?.error?.error;
  if (!body || typeof body !== 'object') return null;

  const fields = body.fields;
  if (fields && typeof fields === 'object') {
    for (const codes of Object.values(fields)) {
      for (const code of Array.isArray(codes) ? codes : [codes]) {
        const hit = i18n.tOrNull(code as string);
        if (hit) return hit;
      }
    }
  }

  return i18n.tOrNull(body.code);
}
