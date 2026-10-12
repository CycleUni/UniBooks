/** Region-prefix helpers for router URLs.
 *
 * Deliberately dependency-free and in its own file: both RegionService and
 * RegionLinkService need this, and RegionLinkService already depends on
 * RegionService — putting it in either one would close a module import cycle.
 */

/** A router URL with its leading `/<region>` segment removed.
 *
 * Anything that *compares* a URL against a route literal needs this, not just
 * the code that builds links. Route prefixing turned `/search` into
 * `/tw/search`, so every `url === '/search'` style check silently stopped
 * matching — that is what removed the site footer from every page and dropped
 * the full-bleed layout on the messages screen.
 *
 * Region codes are ISO 3166-1 alpha-2, and no route in this app is two
 * letters long, so a two-letter first segment is unambiguous.
 */
export function stripRegionPrefix(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const stripped = path.replace(/^\/[A-Za-z]{2}(?=\/|$)/, '');
  return stripped || '/';
}

import { DefaultUrlSerializer, Router, UrlTree } from '@angular/router';

/**
 * Query parameters that point at state belonging to the region being left.
 *
 * `local_cache=true` used to tell the book page to render the preview a list
 * page stashed in sessionStorage — a preview built from the old region's
 * search results, waitlist count and subscription included. That signal now
 * travels as router state (see book-preview.ts), which a region switch's full
 * page load drops by itself; the parameter is still stripped because links
 * copied while it was in the href are still around, and it only ever made a
 * second URL for the same page.
 */
const REGION_BOUND_QUERY_PARAMS = ['local_cache'];

/**
 * The URL to load after switching to `region`: same page, same query string
 * and fragment, different region prefix.
 *
 * Built on stripRegionPrefix alone, the switch used to discard the query —
 * `/tw/book?isbn=…` became a bare `/hk/book` with nothing to show, and the
 * same happened to search terms and every other page that is addressed by
 * its query string.
 */
export function regionSwitchUrl(url: string, region: string): string {
  const serializer = new DefaultUrlSerializer();
  const tree = serializer.parse(url);
  for (const key of REGION_BOUND_QUERY_PARAMS) {
    delete tree.queryParams[key];
  }
  const serialized = serializer.serialize(tree);
  const cut = serialized.search(/[?#]/);
  const path = cut < 0 ? serialized : serialized.slice(0, cut);
  const suffix = cut < 0 ? '' : serialized.slice(cut);
  const rest = stripRegionPrefix(path);
  return `/${region}${rest === '/' ? '' : rest}${suffix}`;
}

/**
 * Creates a UrlTree with the current region prefixed.
 * Accepts an object with a `region()` signal method (like RegionService)
 * to avoid circular dependencies.
 */
export function regionUrlTree(router: Router, regionService: { region: () => string }, commands: any[], options?: any): UrlTree {
  const region = regionService.region();
  let pathArr = Array.isArray(commands) ? commands : [commands];
  let finalCommands = pathArr;
  
  if (pathArr[0] && typeof pathArr[0] === "string" && pathArr[0].startsWith("/")) {
    const parts = pathArr[0].substring(1).split("/").filter(Boolean);
    finalCommands = ["/", region, ...parts, ...pathArr.slice(1)];
  }
  return router.createUrlTree(finalCommands, options);
}

/**
 * Checks if two region codes refer to the same region, ignoring case.
 * 
 * Region codes exist in two forms in this project:
 * - Lowercase: URL prefixes (e.g., /tw), localStorage, RegionService.region()
 * - Uppercase: API responses and database (ISO 3166-1 alpha-2, e.g., 'TW')
 * 
 * Always use this function instead of `===` to compare region codes to avoid false negatives.
 */
export function isSameRegion(code1: string | null | undefined, code2: string | null | undefined): boolean {
  if (!code1 || !code2) return false;
  return code1.toUpperCase() === code2.toUpperCase();
}
