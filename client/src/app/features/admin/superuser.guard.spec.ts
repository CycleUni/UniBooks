import { TestBed } from '@angular/core/testing';
import { UrlTree } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { isObservable, of, throwError, firstValueFrom } from 'rxjs';
import { superuserGuard } from './superuser.guard';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { RegionService } from '../../core/region.service';

describe('superuserGuard', () => {
  let mockAuthStore: any;
  let mockAccountService: any;

  async function runGuard() {
    const result = TestBed.runInInjectionContext(() => superuserGuard({} as any, {} as any));
    return isObservable(result) ? firstValueFrom(result) : result;
  }

  beforeEach(() => {
    mockAuthStore = { isLoggedIn: vi.fn().mockReturnValue(true) };
    mockAccountService = { profileCache: vi.fn().mockReturnValue(null), getMyProfile: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: RegionService, useValue: { region: () => 'tw' } },
        { provide: AuthStore, useValue: mockAuthStore },
        { provide: AccountService, useValue: mockAccountService },
      ],
    });
  });

  it('redirects to / when not logged in', async () => {
    mockAuthStore.isLoggedIn.mockReturnValue(false);
    expect(await runGuard()).toBeInstanceOf(UrlTree);
  });

  it('allows a superuser and refuses a staff member who is not one', async () => {
    mockAccountService.getMyProfile.mockReturnValue(of({ is_staff: true, is_superuser: true }));
    expect(await runGuard()).toBe(true);

    mockAccountService.getMyProfile.mockReturnValue(of({ is_staff: true, is_superuser: false }));
    expect(await runGuard()).toBeInstanceOf(UrlTree);
  });

  it.each([0, 503])('lets the visitor through on a transient failure (%i)', async (status) => {
    mockAccountService.getMyProfile.mockReturnValue(throwError(() => new HttpErrorResponse({ status })));
    expect(await runGuard()).toBe(true);
  });

  it.each([401, 403])('still redirects to / on a real answer (%i)', async (status) => {
    mockAccountService.getMyProfile.mockReturnValue(throwError(() => new HttpErrorResponse({ status })));
    expect(await runGuard()).toBeInstanceOf(UrlTree);
  });
});
