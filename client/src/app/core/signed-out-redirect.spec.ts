import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, CanActivateFn, Route, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { registeredAuthGuards, signedOutRedirectFor } from './signed-out-redirect';
import { authGuard, accountIndexGuard, guestGuard } from './auth.guard';
import { regionGuard, rootRedirectGuard } from './region.guard';
import { adminGuard } from '../features/admin/admin.guard';
import { superuserGuard } from '../features/admin/superuser.guard';
import { routes } from '../app.routes';
import { RegionService } from './region.service';
import { AuthStore } from './auth.store';
import { AccountService } from './services/account.service';

/** signedOutRedirectFor only ever reads routeConfig.canActivate and children,
 *  so a plain object shaped like a snapshot is enough to exercise the walk
 *  without booting the guards (adminGuard would otherwise fetch a profile). */
function fakeSnapshot(canActivate: CanActivateFn[], children: any[] = []): ActivatedRouteSnapshot {
  return { routeConfig: { canActivate }, children } as unknown as ActivatedRouteSnapshot;
}

describe('signedOutRedirectFor()', () => {
  it('returns null for a route tree no guard protects', () => {
    const tree = fakeSnapshot([], [fakeSnapshot([regionGuard], [fakeSnapshot([])])]);
    expect(signedOutRedirectFor(tree)).toBeNull();
  });

  it('finds a guard registered on the activated leaf', () => {
    const tree = fakeSnapshot([], [fakeSnapshot([regionGuard], [fakeSnapshot([authGuard])])]);
    expect(signedOutRedirectFor(tree)).not.toBeNull();
  });

  it('inherits the guard from an ancestor, because most /admin children carry none', () => {
    const adminUsers = fakeSnapshot([], [
      fakeSnapshot([regionGuard], [
        fakeSnapshot([adminGuard], [fakeSnapshot([])]),
      ]),
    ]);
    expect(signedOutRedirectFor(adminUsers)).not.toBeNull();
  });

  it("returns null for the router's initial state, before any navigation has committed", () => {
    // Router.routerState starts as a real, childless root — never null — so
    // this is the shape a pre-first-navigation caller actually sees.
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const root = TestBed.inject(Router).routerState.snapshot.root;
    expect(root).not.toBeNull();
    expect(root.children).toEqual([]);
    expect(signedOutRedirectFor(root)).toBeNull();
  });

  it('tolerates a missing snapshot', () => {
    expect(signedOutRedirectFor(null)).toBeNull();
    expect(signedOutRedirectFor(undefined)).toBeNull();
  });
});

describe('registered destinations', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: RegionService, useValue: { region: signal('tw') } },
        // Signed out: every guard below takes its turn-away branch.
        { provide: AuthStore, useValue: { isLoggedIn: () => false } },
        { provide: AccountService, useValue: { profileCache: () => null, getMyProfile: vi.fn() } },
      ],
    });
  });

  /**
   * The registered redirect, and what the guard itself returns for a
   * signed-out visitor at the same URL. Those two being equal is the entire
   * point of the registry — comparing each to a literal would let a guard
   * change its destination while its registration silently kept the old one.
   */
  function bothDestinations(guard: CanActivateFn, url: string) {
    const router = TestBed.inject(Router);
    const redirect = signedOutRedirectFor(fakeSnapshot([guard]));
    expect(redirect).not.toBeNull();
    const registered = TestBed.runInInjectionContext(() => redirect!(url));
    const own = TestBed.runInInjectionContext(() =>
      guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot));
    expect(own).toBeInstanceOf(UrlTree);
    return { registered: router.serializeUrl(registered), own: router.serializeUrl(own as UrlTree) };
  }

  it('authGuard: registered destination is the one the guard returns — sign in, with returnUrl', () => {
    const { registered, own } = bothDestinations(authGuard, '/tw/account/listings');
    expect(registered).toBe(own);
    expect(registered).toBe('/tw/login?returnUrl=%2Ftw%2Faccount%2Flistings');
  });

  it('accountIndexGuard: registered destination is the one the guard returns', () => {
    const { registered, own } = bothDestinations(accountIndexGuard, '/tw/account');
    expect(registered).toBe(own);
    expect(registered).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
  });

  it('adminGuard: registered destination is the one the guard returns — home, not /login', () => {
    const { registered, own } = bothDestinations(adminGuard, '/tw/admin/users');
    expect(registered).toBe(own);
    expect(registered).toBe('/tw');
  });

  it('superuserGuard: registered destination is the one the guard returns', () => {
    const { registered, own } = bothDestinations(superuserGuard, '/tw/admin/regions');
    expect(registered).toBe(own);
    expect(registered).toBe('/tw');
  });
});

describe('route table drift guard', () => {
  /** Guards that legitimately do NOT turn a signed-out visitor away.
   *  Anything else in the route table must register a destination, or a
   *  session that ends without a navigation will strand the visitor. */
  const publicGuards: CanActivateFn[] = [regionGuard, rootRedirectGuard, guestGuard];

  function collect(routeList: Route[], trail: string[] = []): Array<{ path: string; guard: CanActivateFn }> {
    const found: Array<{ path: string; guard: CanActivateFn }> = [];
    for (const route of routeList) {
      const here = [...trail, route.path ?? ''];
      for (const guard of route.canActivate ?? []) {
        found.push({ path: '/' + here.filter(Boolean).join('/'), guard: guard as CanActivateFn });
      }
      if (route.children) {
        found.push(...collect(route.children, here));
      }
    }
    return found;
  }

  it('every canActivate guard in app.routes.ts is either public or registered', () => {
    const registered = registeredAuthGuards();
    const unclassified = collect(routes)
      .filter(({ guard }) => !registered.has(guard) && !publicGuards.includes(guard))
      .map(({ path }) => path);

    // A new guard lands here until someone decides which it is. Register it
    // with requiresAuth(), or add it to publicGuards above.
    expect(unclassified).toEqual([]);
  });

  it('covers the routes a signed-out visitor must not sit on', () => {
    const registered = registeredAuthGuards();
    const guarded = collect(routes)
      .filter(({ guard }) => registered.has(guard))
      .map(({ path }) => path);

    expect(guarded).toContain('/:region/account');
    expect(guarded).toContain('/:region/messages');
    expect(guarded).toContain('/:region/admin');
    expect(guarded).toContain('/:region/checkout/:id');
  });
});
