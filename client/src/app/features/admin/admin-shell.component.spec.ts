import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Subject, of, throwError } from 'rxjs';

import { AdminShellComponent } from './admin-shell.component';
import { superuserGuard } from './superuser.guard';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { RegionService } from '../../core/region.service';
import { I18nService } from '../../core/i18n.service';

@Component({ standalone: true, template: '<p class="admin-page">admin page</p>' })
class StubPage {}

/**
 * adminGuard and superuserGuard let a visitor in unconfirmed when the backend
 * could not be reached, so the shell is where the decision is finished.
 */
describe('AdminShellComponent access gate', () => {
  let harness: RouterTestingHarness;
  let router: Router;
  let user: ReturnType<typeof signal<any>>;
  let profileCache: ReturnType<typeof signal<any>>;
  let getMyProfile: ReturnType<typeof vi.fn<(...args: any[]) => any>>;

  const unavailable = () => throwError(() => new HttpErrorResponse({ status: 503 }));
  const el = () => harness.fixture.nativeElement as HTMLElement;
  const settle = async () => {
    harness.fixture.detectChanges();
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
  };

  beforeEach(async () => {
    user = signal<any>(null);
    profileCache = signal<any>(null);
    getMyProfile = vi.fn<(...args: any[]) => any>(unavailable);

    TestBed.configureTestingModule({
      providers: [
        provideRouter([{
          path: 'tw',
          children: [
            { path: '', component: StubPage },
            {
              path: 'admin',
              component: AdminShellComponent,
              children: [
                { path: 'users', component: StubPage },
                { path: 'regions', canActivate: [superuserGuard], component: StubPage },
              ],
            },
          ],
        }]),
        { provide: AuthStore, useValue: { isAuthenticated: signal(true), isLoggedIn: () => true, user } },
        { provide: AccountService, useValue: { profileCache, getMyProfile: (...args: any[]) => getMyProfile(...args) } },
        { provide: RegionService, useValue: { region: signal('tw') } },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: signal('en') } },
      ],
    });
    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
  });

  it('shows the admin area straight away when the profile already confirms staff', async () => {
    user.set({ id: 1, is_staff: true });
    await harness.navigateByUrl('/tw/admin/users');
    await settle();

    expect(el().querySelector('.admin-layout')).not.toBeNull();
    expect(el().querySelector('.admin-page')).not.toBeNull();
    expect(el().querySelector('ui-error-state')).toBeNull();
  });

  it('holds the admin pages back until the profile arrives, then shows them in place', async () => {
    await harness.navigateByUrl('/tw/admin/users');
    await settle();

    expect(el().querySelector('.admin-page')).toBeNull();
    expect(el().querySelector('ui-error-state')).not.toBeNull();

    // AuthStore's scheduled retry succeeds.
    user.set({ id: 1, is_staff: true });
    await settle();

    expect(el().querySelector('.admin-page')).not.toBeNull();
    expect(router.url).toBe('/tw/admin/users');
  });

  it('accepts the profile from AccountService as well as from AuthStore', async () => {
    await harness.navigateByUrl('/tw/admin/users');
    await settle();

    profileCache.set({ id: 1, is_staff: true });
    await settle();

    expect(el().querySelector('.admin-page')).not.toBeNull();
  });

  it('sends a visitor home once the profile shows they are not staff', async () => {
    await harness.navigateByUrl('/tw/admin/users');
    await settle();

    user.set({ id: 2, is_staff: false });
    await settle();

    expect(router.url).toBe('/tw');
  });

  it('sends a staff member home from a superuser page once the profile shows they are not one', async () => {
    await harness.navigateByUrl('/tw/admin/regions');   // superuserGuard let a 503 through
    await settle();
    expect(router.url).toBe('/tw/admin/regions');

    user.set({ id: 3, is_staff: true, is_superuser: false });
    await settle();

    expect(router.url).toBe('/tw');
  });

  it('lets a superuser stay on a superuser page', async () => {
    await harness.navigateByUrl('/tw/admin/regions');
    await settle();

    user.set({ id: 4, is_staff: true, is_superuser: true });
    await settle();

    expect(router.url).toBe('/tw/admin/regions');
    expect(el().querySelector('.admin-page')).not.toBeNull();
  });

  it('retries on request, and says it is checking meanwhile', async () => {
    await harness.navigateByUrl('/tw/admin/users');
    await settle();

    const response = new Subject<any>();
    getMyProfile.mockImplementation(() => response);
    (el().querySelector('ui-error-state button') as HTMLButtonElement).click();
    await settle();

    expect(getMyProfile).toHaveBeenCalled();
    expect(el().querySelector('.admin-access-checking')).not.toBeNull();

    profileCache.set({ id: 1, is_staff: true });
    response.next({ id: 1, is_staff: true });
    response.complete();
    await settle();

    expect(el().querySelector('.admin-page')).not.toBeNull();
  });
});
