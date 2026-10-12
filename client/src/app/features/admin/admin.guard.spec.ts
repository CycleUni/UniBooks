import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { isObservable, of, throwError, firstValueFrom } from 'rxjs';
import { adminGuard } from './admin.guard';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { RegionService } from '../../core/region.service';


describe('adminGuard', () => {
  let mockAuthStore: any;
  let mockAccountService: any;
  let router: Router;

  async function runGuard() {
    const result = TestBed.runInInjectionContext(() => adminGuard({} as any, {} as any));
    return isObservable(result) ? firstValueFrom(result) : result;
  }

  beforeEach(() => {
    mockAuthStore = { isLoggedIn: vi.fn() };
    mockAccountService = { profileCache: vi.fn(), getMyProfile: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        { provide: AuthStore, useValue: mockAuthStore },
        { provide: AccountService, useValue: mockAccountService },
      ]
    });

    router = TestBed.inject(Router);
  });

  it('redirects to / when not logged in', async () => {
    mockAuthStore.isLoggedIn.mockReturnValue(false);

    const result = await runGuard();

    expect(result).toBeInstanceOf(UrlTree);
    expect(mockAccountService.getMyProfile).not.toHaveBeenCalled();
  });

  it('allows access when the cached profile has is_staff true', async () => {
    mockAuthStore.isLoggedIn.mockReturnValue(true);
    mockAccountService.profileCache.mockReturnValue({ is_staff: true });

    const result = await runGuard();

    expect(result).toBe(true);
  });

  it('redirects to / when the cached profile has is_staff false', async () => {
    mockAuthStore.isLoggedIn.mockReturnValue(true);
    mockAccountService.profileCache.mockReturnValue({ is_staff: false });

    const result = await runGuard();

    expect(result).toBeInstanceOf(UrlTree);
  });

  it('fetches the profile first when the cache is empty, then allows staff through', async () => {
    mockAuthStore.isLoggedIn.mockReturnValue(true);
    mockAccountService.profileCache.mockReturnValue(null);
    mockAccountService.getMyProfile.mockReturnValue(of({ is_staff: true }));

    const result = await runGuard();

    expect(mockAccountService.getMyProfile).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('fetches the profile first when the cache is empty, then redirects non-staff', async () => {
    mockAuthStore.isLoggedIn.mockReturnValue(true);
    mockAccountService.profileCache.mockReturnValue(null);
    mockAccountService.getMyProfile.mockReturnValue(of({ is_staff: false }));

    const result = await runGuard();

    expect(result).toBeInstanceOf(UrlTree);
  });

  it('redirects to / if the profile fetch errors', async () => {
    mockAuthStore.isLoggedIn.mockReturnValue(true);
    mockAccountService.profileCache.mockReturnValue(null);
    mockAccountService.getMyProfile.mockReturnValue(throwError(() => new Error('network error')));

    const result = await runGuard();

    expect(result).toBeInstanceOf(UrlTree);
  });

  // A cold serverless start can fail the profile request for a few seconds.
  // That says nothing about whether the visitor is staff, so it must not send
  // a signed-in admin home; AdminShellComponent finishes the check.
  describe('when the profile request fails', () => {
    beforeEach(() => {
      mockAuthStore.isLoggedIn.mockReturnValue(true);
      mockAccountService.profileCache.mockReturnValue(null);
    });

    it.each([0, 429, 502, 503, 504])('lets the visitor through on a transient failure (%i)', async (status) => {
      mockAccountService.getMyProfile.mockReturnValue(throwError(() => new HttpErrorResponse({ status })));

      expect(await runGuard()).toBe(true);
    });

    it.each([401, 403, 404])('still redirects to / on a real answer (%i)', async (status) => {
      mockAccountService.getMyProfile.mockReturnValue(throwError(() => new HttpErrorResponse({ status })));

      expect(await runGuard()).toBeInstanceOf(UrlTree);
    });
  });
});

