import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map, catchError, of } from 'rxjs';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { RegionService } from '../../core/region.service';
import { regionUrlTree } from '../../core/region-path';
import { requiresAuth } from '../../core/signed-out-redirect';
import { isTransientHttpFailure } from '../../core/http-failure';

// Same shape as adminGuard, and for the same reason: `is_superuser` only
// exists client-side in AccountService.profileCache (GET /auth/me/). AuthStore
// holds what login returned and is not rehydrated on page load, so reading
// `auth.user()?.is_superuser` synchronously sends a genuine superuser away on
// any direct navigation or refresh — the cache is still empty at that point.
//
// Redirects through regionUrlTree rather than parseUrl('/'), so the bounce
// keeps the region prefix instead of dropping the user at a region-less root.
export const superuserGuard: CanActivateFn = requiresAuth(() => {
  const auth = inject(AuthStore);
  const accountService = inject(AccountService);
  const router = inject(Router);
  const regionService = inject(RegionService);

  const deny = () => regionUrlTree(router, regionService, ['/']);

  if (!auth.isLoggedIn()) {
    return deny();
  }

  const cached = accountService.profileCache();
  if (cached) {
    return cached.is_superuser === true ? true : deny();
  }

  // Same as adminGuard: only a real answer denies. AdminShellComponent checks
  // is_superuser for these routes once the profile arrives.
  return accountService.getMyProfile().pipe(
    map(profile => (profile?.is_superuser === true ? true : deny())),
    catchError(err => of(isTransientHttpFailure(err) ? true : deny()))
  );
// Same as adminGuard: a silent session end goes home, not to /login.
}, () => regionUrlTree(inject(Router), inject(RegionService), ['/']));
