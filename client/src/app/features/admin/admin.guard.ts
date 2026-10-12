import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { map, catchError, of } from 'rxjs';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { RegionService } from '../../core/region.service';
import { regionUrlTree } from '../../core/region-path';
import { requiresAuth } from '../../core/signed-out-redirect';
import { isTransientHttpFailure } from '../../core/http-failure';

// Gates the whole /admin/* section on the current user's `is_staff` flag.
// `AccountService.profileCache` (backed by GET /auth/me/) is the only place
// that flag lives client-side — AuthStore only ever holds the bare
// email/id set at login and is never rehydrated on page load — so a direct
// nav to /admin (fresh load, cache still empty) has to fetch the profile
// first rather than assume it's already populated.
export const adminGuard: CanActivateFn = requiresAuth(() => {
  const auth = inject(AuthStore);
  const accountService = inject(AccountService);
  const router = inject(Router);
  const regionService = inject(RegionService);

  if (!auth.isLoggedIn()) {
    return regionUrlTree(router, regionService, ['/']);
  }

  const cached = accountService.profileCache();
  if (cached) {
    return cached.is_staff === true ? true : regionUrlTree(router, regionService, ['/']);
  }

  // A failure to *reach* the backend is not an answer to "is this staff?". On a
  // cold serverless start the profile request can fail for a few seconds, and
  // sending a signed-in admin home for it looked like being thrown out of the
  // admin area. So only a real answer denies here; a transient failure lets the
  // visitor through to AdminShellComponent, which holds the admin pages back
  // until the profile confirms access (and sends them home if it does not).
  // Nothing is exposed meanwhile: every admin endpoint enforces staff itself.
  return accountService.getMyProfile().pipe(
    map(profile => (profile?.is_staff === true ? true : regionUrlTree(router, regionService, ['/']))),
    catchError(err => of(isTransientHttpFailure(err) ? true : regionUrlTree(router, regionService, ['/'])))
  );
// A session that ends without a navigation lands where this guard would have
// put it — home, not /login: see signed-out-redirect.ts.
}, () => regionUrlTree(inject(Router), inject(RegionService), ['/']));
