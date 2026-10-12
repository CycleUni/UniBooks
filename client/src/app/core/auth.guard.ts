import { inject } from '@angular/core';
import { isPhoneViewport } from './viewport';
import { Router, CanActivateFn } from '@angular/router';
import { RegionService } from './region.service';
import { regionUrlTree } from './region-path';
import { AuthStore } from './auth.store';
import { requiresAuth } from './signed-out-redirect';

/** Where this guard family puts a visitor who is not signed in. Registered
 *  alongside each guard so a session that ends *without* a navigation lands
 *  in the same place a navigation would have — see signed-out-redirect.ts. */
const toLogin = (returnUrl: string) =>
  regionUrlTree(inject(Router), inject(RegionService), ['/login'], { queryParams: { returnUrl } });

export const authGuard: CanActivateFn = requiresAuth((route, state) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const regionService = inject(RegionService);

  if (auth.isLoggedIn()) {
    return true;
  }

  return regionUrlTree(router, regionService, ['/login'], { queryParams: { returnUrl: state.url } });
}, toLogin);

/** /login and /register are for people who are not signed in. Someone who is
 *  gets sent on rather than shown a form they cannot use — honouring
 *  returnUrl, so a stale link into the gate still ends where it promised. */
export const guestGuard: CanActivateFn = (route) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const regionService = inject(RegionService);

  if (!auth.isLoggedIn()) {
    return true;
  }

  const returnUrl = route.queryParamMap.get('returnUrl');
  if (returnUrl) {
    return router.parseUrl(returnUrl);
  }
  return regionUrlTree(router, regionService, ['/account']);
};

export const accountIndexGuard: CanActivateFn = requiresAuth((route, state) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const regionService = inject(RegionService);

  if (auth.isLoggedIn()) {
    // Phones stay: /account is the account menu there, each item a page of
    // its own. Wide screens show the menu as a sidebar beside a page, so
    // they open the first one.
    return isPhoneViewport() ? true : regionUrlTree(router, regionService, ['/account', 'listings']);
  }

  // The parent route's authGuard normally catches this first; this is the
  // second line of defence for an old bookmark that lands straight on
  // /account, which used to render the login wall itself.
  return regionUrlTree(router, regionService, ['/login'], { queryParams: { returnUrl: state.url } });
}, toLogin);
