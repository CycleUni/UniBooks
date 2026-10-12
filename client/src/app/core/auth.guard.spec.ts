import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, convertToParamMap } from '@angular/router';
import { authGuard, accountIndexGuard, guestGuard } from './auth.guard';
import { AuthStore } from './auth.store';
import { RegionService } from './region.service';
import { AccountIndexComponent } from '../features/account/account-index.component';

/** A minimal ActivatedRouteSnapshot stand-in: the guards only ever read
 *  queryParamMap off it. */
const routeWith = (queryParams: Record<string, string> = {}) =>
  ({ queryParamMap: convertToParamMap(queryParams) }) as any;

describe('Auth Guards & Account Routing', () => {
  let mockAuthStore: any;
  let mockRegionService: any;
  let router: Router;

  beforeEach(() => {
    mockAuthStore = { isLoggedIn: vi.fn() };
    mockRegionService = { region: vi.fn(() => 'tw') };

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthStore, useValue: mockAuthStore },
        { provide: RegionService, useValue: mockRegionService }
      ]
    });
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('accountIndexGuard', () => {
    it('redirects to /tw/account/listings when logged in and region is tw', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(true);
      mockRegionService.region.mockReturnValue('tw');
      const result = TestBed.runInInjectionContext(() => accountIndexGuard(routeWith(), {} as any)) as UrlTree;
      expect(result).toBeInstanceOf(UrlTree);
      expect(result.toString()).toBe('/tw/account/listings');
    });

    it('redirects to /hk/account/listings when logged in and region is hk', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(true);
      mockRegionService.region.mockReturnValue('hk');
      const result = TestBed.runInInjectionContext(() => accountIndexGuard(routeWith(), {} as any)) as UrlTree;
      expect(result).toBeInstanceOf(UrlTree);
      expect(result.toString()).toBe('/hk/account/listings');
    });

    it('lets a signed-in phone stay on /account, where the menu is', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(true);
      vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
      const result = TestBed.runInInjectionContext(() => accountIndexGuard(routeWith(), {} as any));
      expect(result).toBe(true);
    });

    it('sends a signed-out visitor to /login instead of rendering nothing', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(false);
      mockRegionService.region.mockReturnValue('tw');
      const result = TestBed.runInInjectionContext(
        () => accountIndexGuard(routeWith(), { url: '/tw/account' } as any)
      ) as UrlTree;
      expect(result).toBeInstanceOf(UrlTree);
      expect(result.toString()).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
    });
  });

  describe('authGuard', () => {
    it('redirects to /tw/login with returnUrl when not logged in', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(false);
      mockRegionService.region.mockReturnValue('tw');
      const result = TestBed.runInInjectionContext(() => authGuard(routeWith(), { url: '/some/protected/route' } as any)) as UrlTree;
      expect(result).toBeInstanceOf(UrlTree);
      expect(result.toString()).toBe('/tw/login?returnUrl=%2Fsome%2Fprotected%2Froute');
    });

    // The old bookmark case: /account no longer renders a login form itself.
    it('sends a signed-out visitor opening /tw/account to /tw/login with returnUrl', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(false);
      mockRegionService.region.mockReturnValue('tw');
      const result = TestBed.runInInjectionContext(() => authGuard(routeWith(), { url: '/tw/account' } as any)) as UrlTree;
      expect(result.toString()).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
    });

    it('lets a signed-in user through', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(true);
      const result = TestBed.runInInjectionContext(() => authGuard(routeWith(), { url: '/tw/account' } as any));
      expect(result).toBe(true);
    });
  });

  describe('guestGuard', () => {
    it('lets a signed-out visitor see /login', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(false);
      const result = TestBed.runInInjectionContext(() => guestGuard(routeWith(), {} as any));
      expect(result).toBe(true);
    });

    it('sends a signed-in user opening /login on to /tw/account', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(true);
      mockRegionService.region.mockReturnValue('tw');
      const result = TestBed.runInInjectionContext(() => guestGuard(routeWith(), {} as any)) as UrlTree;
      expect(result).toBeInstanceOf(UrlTree);
      expect(result.toString()).toBe('/tw/account');
    });

    it('honours returnUrl when a signed-in user opens /login from a gate', () => {
      mockAuthStore.isLoggedIn.mockReturnValue(true);
      const result = TestBed.runInInjectionContext(
        () => guestGuard(routeWith({ returnUrl: '/tw/listing/42' }), {} as any)
      ) as UrlTree;
      expect(result).toBeInstanceOf(UrlTree);
      expect(result.toString()).toBe('/tw/listing/42');
    });
  });

  describe('AccountIndexComponent', () => {
    it('redirects to /tw/account/listings on init (prevents blank screen)', () => {
      const navigateSpy = vi.spyOn(router, 'navigate').mockImplementation(() => Promise.resolve(true));
      mockRegionService.region.mockReturnValue('tw');
      const component = TestBed.runInInjectionContext(() => new AccountIndexComponent());
      component.ngOnInit();
      expect(navigateSpy).toHaveBeenCalledWith(['/tw/account/listings'], { replaceUrl: true });
    });

    it('stays on /account on phones, where the account page shows its menu', () => {
      const navigateSpy = vi.spyOn(router, 'navigate').mockImplementation(() => Promise.resolve(true));
      vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
      const component = TestBed.runInInjectionContext(() => new AccountIndexComponent());
      component.ngOnInit();
      expect(navigateSpy).not.toHaveBeenCalled();
    });
  });
});
