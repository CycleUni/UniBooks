/**
 * The event site is a separate Worker mounted at /event on this origin, so the
 * SPA router cannot reach it: a returnUrl into it needs a full page load.
 * Only a same-origin /event path qualifies. Anything else, an absolute URL
 * included, stays with the router, which cannot leave the site.
 */
export function isEventPath(url: string): boolean {
  return /^\/event(?:[/?#]|$)/.test(url);
}
