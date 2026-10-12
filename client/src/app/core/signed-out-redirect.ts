import { ActivatedRouteSnapshot, CanActivateFn, UrlTree } from '@angular/router';

/**
 * Where a route sends a visitor who is not signed in.
 *
 * Called inside an injection context, so an implementation may `inject()`
 * whatever it needs (Router, RegionService) exactly the way the guard that
 * registered it does.
 */
export type SignedOutRedirect = (returnUrl: string) => UrlTree;

/**
 * Guards that refuse a signed-out visitor, mapped to the destination each one
 * sends them to.
 *
 * This exists because a session can end *without* a navigation: the access
 * token expires, the refresh is refused, and AuthStore clears the session
 * while the visitor is already sitting on a page. Guards only run on
 * navigation, so nothing re-evaluates the page they are on. AuthStore needs
 * to answer "can this visitor still see where they are, and if not, where do
 * they belong?" — and the honest answer is whatever the guard would have
 * said, which differs per guard: authGuard sends people to /login with a
 * returnUrl, while adminGuard sends them home. Registering the destination
 * next to the guard's own logic keeps those two from drifting apart.
 *
 * Re-running the guards instead would be the obvious alternative, and it does
 * not work: `navigateByUrl(router.url, {onSameUrlNavigation:'reload'})`
 * completes without invoking canActivate at all, because guard re-runs are
 * gated separately by `runGuardsAndResolvers`, whose default resolves to
 * false for a byte-identical URL. Making that work would mean annotating
 * every guarded route, and would still scroll the page to the top on the
 * public pages where we want to do nothing at all.
 *
 * This module deliberately imports nothing from AuthStore or from the guards:
 * the guards import it, AuthStore imports it, and it imports neither back.
 * A direct AuthStore -> auth.guard import would close a module cycle, and
 * this file is the seam that avoids it.
 */
const signedOutRedirects = new Map<CanActivateFn, SignedOutRedirect>();

/**
 * Declare that `guard` turns signed-out visitors away, and where it sends
 * them. Returns the guard unchanged so it can wrap the definition in place —
 * the registry is keyed on the same function reference that ends up in
 * `Route.canActivate`, which is what the snapshot walk below looks for.
 */
export function requiresAuth(guard: CanActivateFn, redirect: SignedOutRedirect): CanActivateFn {
  signedOutRedirects.set(guard, redirect);
  return guard;
}

/**
 * The redirect for the currently activated route tree, or null when the
 * visitor is somewhere a signed-out visitor is welcome.
 *
 * Walks root-first and takes the shallowest match, because most guarded
 * children carry no guard of their own — nearly every route under /admin
 * relies on the parent's adminGuard alone, so reading only the deepest
 * `routeConfig` would miss them.
 *
 * Reads whatever snapshot it is given. The caller must pass one for a
 * navigation that has COMMITTED: mid-navigation, routerState still describes
 * the page being left (see AuthStore.afterNavigationSettles).
 */
export function signedOutRedirectFor(root: ActivatedRouteSnapshot | null | undefined): SignedOutRedirect | null {
  if (!root) return null;

  const queue: ActivatedRouteSnapshot[] = [root];
  while (queue.length > 0) {
    const snapshot = queue.shift()!;
    for (const guard of snapshot.routeConfig?.canActivate ?? []) {
      const redirect = signedOutRedirects.get(guard as CanActivateFn);
      if (redirect) return redirect;
    }
    queue.push(...snapshot.children);
  }
  return null;
}

/** Test seam: the guards registered so far. Not for production use. */
export function registeredAuthGuards(): ReadonlySet<CanActivateFn> {
  return new Set(signedOutRedirects.keys());
}
