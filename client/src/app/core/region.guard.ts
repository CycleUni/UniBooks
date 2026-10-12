import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, PRIMARY_OUTLET, Route, Router, UrlSegment, UrlTree } from '@angular/router';
import { RegionService } from './region.service';
import { DEFAULT_REGION } from './i18n';

/**
 * Swap the leading path segment, keeping everything else byte-identical.
 *
 * This used to be `state.url.replace('/' + regionParam, '/' + fallback)`, which
 * compares a *decoded* route parameter against an *encoded* URL string. They
 * differ for any segment that needed escaping — `/a%20b/search` yields the
 * parameter `a b`, which does not occur in the URL — so the replace found
 * nothing, the guard returned the URL it was given, and navigating to it ran
 * the guard again: a redirect loop rather than a fallback.
 *
 * Editing the parsed tree sidesteps the comparison entirely, and carries query
 * parameters, matrix parameters and the fragment across untouched.
 */
function withRegion(router: Router, url: string, region: string): UrlTree {
  const tree = router.parseUrl(url);
  const primary = tree.root.children[PRIMARY_OUTLET];
  if (!primary || primary.segments.length === 0) {
    return router.parseUrl(`/${region}`);
  }
  primary.segments[0] = new UrlSegment(region, primary.segments[0].parameters);
  return tree;
}

/**
 * Prefix the region instead of overwriting the first segment.
 *
 * Same tree editing as withRegion, and the same reason for doing it that way.
 */
function prefixedWithRegion(router: Router, url: string, region: string): UrlTree {
  const tree = router.parseUrl(url);
  const primary = tree.root.children[PRIMARY_OUTLET];
  if (!primary || primary.segments.length === 0) {
    return router.parseUrl(`/${region}`);
  }
  primary.segments.unshift(new UrlSegment(region, {}));
  return tree;
}

/**
 * First path segment of a URL, decoded — the thing the `:region` parameter
 * captured.
 */
function firstSegment(router: Router, url: string): string {
  const primary = router.parseUrl(url).root.children[PRIMARY_OUTLET];
  return primary?.segments[0]?.path ?? '';
}

/**
 * Is this segment the start of one of the app's own routes rather than a
 * (mistyped) region code?
 *
 * Every feature route is mounted under `:region`, so a link without the
 * prefix — `/messages?chat=…` in a notification email, `/verify?token=…` in
 * an activation email, an old bookmark — arrives here with `region` bound to
 * `messages` / `verify`. Overwriting that segment with the fallback region
 * (which is what an unrecognised region code deserves) silently drops the
 * page the link was for and lands on the homepage instead, query string and
 * all. Recognising it as a route means prefixing rather than replacing.
 *
 * Read off the live route table at call time rather than importing it: the
 * route table imports this guard, and importing it back would be a cycle
 * whose failure mode is a module-initialisation error, not a warning.
 */
function isFeatureRoutePath(route: ActivatedRouteSnapshot, router: Router, segment: string): boolean {
  const children: Route[] =
    route.routeConfig?.children ??
    router.config.find(r => r.path === ':region')?.children ??
    [];
  return children.some(child => {
    const path = child.path;
    if (!path || path === '**') return false;
    // `listing/:id` is reached as `/listing/<uuid>`; only its first segment
    // can be compared against the one segment we have here.
    return path.split('/')[0] === segment;
  });
}

export const regionGuard: CanActivateFn = (route, state) => {
  const regionService = inject(RegionService);
  const router = inject(Router);
  const regionParam = route.paramMap.get('region');
  
  if (!regionParam) return true;

  const code = regionParam.toLowerCase();
  const regs = regionService.regions();
  
  // if regions not loaded yet, just let it pass and service will handle?
  // no, regions is fetched in constructor, but it might be async.
  // Assuming we have basic known regions or allow anything for now, 
  // then RegionService enforces.
  // Actually, we can just enforce 'tw' or 'hk' or what is in regions().
  
  const known = regs.length > 0
    ? regs.some(r => r.code.toLowerCase() === code)
    : code === 'tw' || code === 'hk';

  if (!known) {
    // A route path that simply arrived without its region prefix keeps its
    // path and gains the viewer's current region; anything else is treated
    // as a bad region code and replaced, as before.
    if (isFeatureRoutePath(route, router, firstSegment(router, state.url))) {
      const current = (regionService.region() || regs[0]?.code || 'tw').toLowerCase();
      return prefixedWithRegion(router, state.url, current);
    }
    return withRegion(router, state.url, (regs[0]?.code || 'tw').toLowerCase());
  }
  
  // Also notify RegionService of current region in URL so they stay in sync
  if (regionService.region() !== code) {
    regionService.setRegion(code, true);
  }
  
  return true;
};

export const rootRedirectGuard: CanActivateFn = async (route, state) => {
  const regionService = inject(RegionService);
  const router = inject(Router);

  // A first visit waits (briefly, capped inside) for IP detection so it lands
  // on the right region instead of being bounced there by a reload later.
  await regionService.detectInitialRegion();

  const code = regionService.region() || DEFAULT_REGION;

  // Prefix the parsed tree rather than the string. Concatenating turned "/"
  // into "/tw/", a trailing slash that matches no route; stripping it only
  // when the URL was exactly "/" still left "/?fbclid=…" — every link from
  // Facebook or Instagram — and campaign "?utm_…" links landing on a 404.
  const tree = router.parseUrl(state.url);
  const primary = tree.root.children[PRIMARY_OUTLET];
  if (primary && primary.segments.length > 0) {
    primary.segments.unshift(new UrlSegment(code, {}));
    return tree;
  }
  return router.createUrlTree(['/', code], {
    queryParams: tree.queryParams,
    fragment: tree.fragment ?? undefined,
  });
};
