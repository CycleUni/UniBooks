import type { ActivatedRoute, Router } from '@angular/router';

/**
 * Query parameters that carry a one-time credential: the password-reset and
 * registration links (`token`) and the email-change confirmation
 * (`email_change_token`). Each is good for its whole lifetime to whoever
 * holds it, so it must not reach analytics, error reports or session replays,
 * which every route change's URL otherwise does.
 */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = ['token', 'email_change_token'];

const REDACTED = 'redacted';

/** `url` with every sensitive parameter's value replaced. Works on absolute
 *  URLs and on the router's relative ones; anything unparseable comes back
 *  with its whole query string dropped rather than as it was. */
export function redactSensitiveUrl(url: string): string {
  if (!url || !url.includes('?')) return url;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  try {
    const parsed = new URL(url, 'http://relative.invalid');
    let changed = false;
    for (const name of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(name)) {
        parsed.searchParams.set(name, REDACTED);
        changed = true;
      }
    }
    if (!changed) return url;
    return absolute ? parsed.toString() : parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url.split('?')[0];
  }
}

/** Take the one-time tokens out of the address bar once a page has read them,
 *  so they do not stay in history, a copied link, or a session replay. */
export function clearSensitiveParams(router: Router, route: ActivatedRoute): void {
  const queryParams = Object.fromEntries(SENSITIVE_QUERY_PARAMS.map(name => [name, null]));
  void router.navigate([], { relativeTo: route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
}
