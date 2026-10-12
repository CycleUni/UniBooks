import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError, Observable } from 'rxjs';
import { Account } from './account';
import { AccountService } from '../../core/services/account.service';
import { OrderService } from '../../core/services/order.service';
import { AuthStore } from '../../core/auth.store';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

// The shell's language effect called loadProfile(), and AccountService's
// getMyProfile reads its own cache/loading signals — so the effect started
// tracking them, re-ran as the profile loaded and was cached, and every run
// fetched the whole order list again for the unread dot (three /orders/
// calls for one visit to My listings).
describe('Account shell', () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver; the shell watches its nav with one.
    (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  });

  it('loads the profile once, however the profile signals change afterwards', () => {
    const profileCache = signal<unknown>(null);
    const getMyProfile = vi.fn(() => {
      profileCache();   // what the real service reads synchronously
      return of({ id: 1, myListingCounts: { active: 0, sold: 0 }, mySubscriptions: [] });
    });
    const checkUnreadOrders = vi.fn();
    TestBed.configureTestingModule({
      imports: [Account],
      providers: [
        provideRouter([]),
        { provide: AccountService, useValue: { getMyProfile } },
        { provide: OrderService, useValue: { checkUnreadOrders, unreadOrders$: of(false) } },
        { provide: AuthStore, useValue: { user: signal(null), isAuthenticated: signal(true), getUser: () => null, logout: () => of(null) } },
        { provide: RegionService, useValue: { region: signal('tw'), regions: signal([]), currentRegionObj: signal(null), currency: signal({ code: 'TWD', decimal_places: 0 }) } },
        { provide: I18nService, useValue: { lang: signal('zh-TW'), t: (k: string) => k } },
      ],
    });
    TestBed.createComponent(Account);
    TestBed.tick();

    profileCache.set({ id: 1 });
    TestBed.tick();
    profileCache.set({ id: 1, again: true });
    TestBed.tick();

    expect(getMyProfile).toHaveBeenCalledTimes(1);
    expect(checkUnreadOrders).toHaveBeenCalledTimes(1);
  });

  // Before /auth/me/ answers, "User", "No school" and three zero counts would
  // read as facts about the account; the card holds placeholders instead.
  describe('profile card', () => {
    const create = (getMyProfile: () => Observable<unknown>) => {
      TestBed.configureTestingModule({
        imports: [Account],
        providers: [
          provideRouter([]),
          { provide: AccountService, useValue: { getMyProfile } },
          { provide: OrderService, useValue: { checkUnreadOrders: vi.fn(), unreadOrders$: of(false) } },
          { provide: AuthStore, useValue: { user: signal(null), isAuthenticated: signal(true), getUser: () => null, logout: () => of(null) } },
          { provide: RegionService, useValue: { region: signal('tw'), regions: signal([]), currentRegionObj: signal(null), currency: signal({ code: 'TWD', decimal_places: 0 }) } },
          { provide: I18nService, useValue: { lang: signal('zh-TW'), t: (k: string) => k } },
        ],
      });
      const fixture = TestBed.createComponent(Account);
      TestBed.tick();
      fixture.detectChanges();
      return fixture;
    };

    it('shows placeholders while the profile is on its way', () => {
      const fixture = create(() => new Observable(() => {}));
      const card: HTMLElement = fixture.nativeElement.querySelector('.profile-card');
      expect(card.querySelector('.avatar.ph')).not.toBeNull();
      expect(card.querySelector('.profile-stats .ph')).not.toBeNull();
      expect(card.textContent).not.toContain('acct.defaultUser');
    });

    it('drops the placeholders but not into invented counts when the load fails', () => {
      const fixture = create(() => throwError(() => ({ status: 500 })));
      const card: HTMLElement = fixture.nativeElement.querySelector('.profile-card');
      expect(card.querySelector('.ph')).toBeNull();
      expect(card.querySelector('.profile-stats')).toBeNull();
    });
  });
});
