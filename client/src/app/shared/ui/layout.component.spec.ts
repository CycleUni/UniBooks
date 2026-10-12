import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { UiLayout } from './layout.component';
import { Router, provideRouter } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { MetadataService } from '../../core/services/metadata.service';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { MessageService } from '../../core/services/message.service';
import { I18nService } from '../../core/i18n.service';
import { ThemeService } from '../../core/services/theme.service';
import { MobileLayoutService } from '../../core/services/mobile-layout.service';
import { RegionService } from '../../core/region.service';


@Component({ standalone: true, template: '' })
class DummyRouteComponent {}

describe('UiLayout', () => {
  let component: UiLayout;
  let fixture: ComponentFixture<UiLayout>;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UiLayout],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        provideRouter([
          { path: '', component: DummyRouteComponent },
          { path: 'search', component: DummyRouteComponent },
          { path: 'sell', component: DummyRouteComponent },
          { path: 'account', component: DummyRouteComponent },
          { path: 'messages', component: DummyRouteComponent },
          { path: 'book/:id', component: DummyRouteComponent },
          { path: '**', component: DummyRouteComponent }
        ]),
        { provide: MetadataService, useValue: { getMetadata: () => of({ schools: [] }), getMetadataWithRetry: vi.fn(() => of({ schools: [] })) } },
        { provide: AuthStore, useValue: { isAuthenticated: signal(false), user: signal(null) } },
        { provide: AccountService, useValue: {} },
        { provide: SchoolStateService, useValue: { currentSchool: '', selectedSchool$: of(''), hasInitialized: false, ready: false, markReady: vi.fn(), getManualSchool: () => null, hasManualPick: () => false, setSchools: vi.fn(), setSchool: vi.fn(), clearManualSchool: vi.fn() } },
        { provide: MessageService, useValue: { unreadCount$: of(0), openHub: vi.fn(), closeHub: vi.fn(), retryHubIfOwed: vi.fn() } },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: signal('zh-TW'), suggestionSettled: () => true } },
        { provide: ThemeService, useValue: { mode: signal('system'), resolved: signal('light'), setMode: vi.fn() } },
        { provide: MobileLayoutService, useValue: { hideBottomNav: signal(false), setHideBottomNav: vi.fn() } },
      ]
    }).compileComponents();

    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(UiLayout);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows the footer on home route ("/")', async () => {
    await router.navigateByUrl('/');
    fixture.detectChanges();

    expect(component.showFooter).toBe(true);
    expect(fixture.nativeElement.querySelector('.app-footer')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.footer-tagline')).toBeTruthy();
  });

  it('shows the footer on search route ("/search")', async () => {
    await router.navigateByUrl('/search');
    fixture.detectChanges();

    expect(component.showFooter).toBe(true);
    expect(fixture.nativeElement.querySelector('.app-footer')).toBeTruthy();
  });

  it('shows the footer on search with query params ("/search?q=biology")', async () => {
    await router.navigateByUrl('/search?q=biology');
    fixture.detectChanges();

    expect(component.showFooter).toBe(true);
    expect(fixture.nativeElement.querySelector('.app-footer')).toBeTruthy();
  });

  it('hides the entire footer bar on other routes', async () => {
    await router.navigateByUrl('/sell');
    fixture.detectChanges();

    expect(component.showFooter).toBe(false);
    expect(fixture.nativeElement.querySelector('.app-footer')).toBeNull();

    await router.navigateByUrl('/account');
    fixture.detectChanges();
    expect(component.showFooter).toBe(false);
    expect(fixture.nativeElement.querySelector('.app-footer')).toBeNull();

    await router.navigateByUrl('/book/123');
    fixture.detectChanges();
    expect(component.showFooter).toBe(false);
    expect(fixture.nativeElement.querySelector('.app-footer')).toBeNull();
  });

  describe('bottom navigation bar', () => {
    let mobileLayout: any;

    beforeEach(() => {
      mobileLayout = TestBed.inject(MobileLayoutService) as any;
    });

    it('keeps it hidden when a page only changes its query string', async () => {
      // The messages page hides the bar when a chat opens, and puts the chat
      // in the URL as ?chat=<id>. That navigation must not undo the hiding.
      await router.navigateByUrl('/messages');
      mobileLayout.setHideBottomNav.mockClear();

      await router.navigateByUrl('/messages?chat=abc');

      expect(mobileLayout.setHideBottomNav).not.toHaveBeenCalled();
    });

    it('brings it back when the page itself changes', async () => {
      await router.navigateByUrl('/messages?chat=abc');
      mobileLayout.setHideBottomNav.mockClear();

      await router.navigateByUrl('/search');

      expect(mobileLayout.setHideBottomNav).toHaveBeenCalledWith(false);
    });
  });

  it('hides the entire footer on full-bleed routes like /messages', async () => {
    await router.navigateByUrl('/messages');
    fixture.detectChanges();

    expect(component.fullBleed).toBe(true);
    const footer = fixture.nativeElement.querySelector('.app-footer');
    expect(footer).toBeNull();
  });

  describe('region and language pickers', () => {
    const onPhone = () => (component as any).isPhone.set(true);

    it('stay under the page on wide screens', async () => {
      (TestBed.inject(AuthStore).isAuthenticated as any).set(true);
      await router.navigateByUrl('/');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.footer-prefs ui-prefs-selector')).toBeTruthy();
    });

    it('move to the account menu on a signed-in phone', async () => {
      (TestBed.inject(AuthStore).isAuthenticated as any).set(true);
      onPhone();
      await router.navigateByUrl('/');
      fixture.detectChanges();

      expect(component.showPrefs).toBe(false);
      expect(fixture.nativeElement.querySelector('ui-prefs-selector')).toBeNull();
    });

    it('leave ordinary pages on a signed-out phone', async () => {
      onPhone();
      await router.navigateByUrl('/book/1');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('ui-prefs-selector')).toBeNull();
    });

    it('stay on the sign-in page on a signed-out phone, which has no account menu', async () => {
      onPhone();
      await router.navigateByUrl('/login');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.standalone-prefs-container ui-prefs-selector')).toBeTruthy();
    });
  });

  describe('account link while the profile is loading', () => {
    const accountLink = () =>
      (fixture.nativeElement as HTMLElement).querySelector('.nav-links a[href$="/account"]') as HTMLAnchorElement;

    it('shows a placeholder, not the signed-out label, while signed in without a profile', () => {
      const auth = TestBed.inject(AuthStore) as any;
      auth.isAuthenticated.set(true);
      fixture.detectChanges();

      const link = accountLink();
      expect(link.querySelector('.nav-label-pending')).not.toBeNull();
      expect(link.textContent?.trim()).toBe('');
      // Still named for assistive technology.
      expect(link.getAttribute('aria-label')).toBe('nav.account');
      expect(link.getAttribute('aria-busy')).toBe('true');
    });

    it('shows the name once the profile arrives', () => {
      const auth = TestBed.inject(AuthStore) as any;
      auth.isAuthenticated.set(true);
      auth.user.set({ id: 1, email: 'staff@x.y', display_name: 'Staff Member' });
      fixture.detectChanges();

      const link = accountLink();
      expect(link.querySelector('.nav-label-pending')).toBeNull();
      expect(link.textContent?.trim()).toBe('Staff Member');
      expect(link.hasAttribute('aria-label')).toBe(false);
    });

    it('keeps the plain account label when signed out', () => {
      fixture.detectChanges();

      const link = accountLink();
      expect(link.querySelector('.nav-label-pending')).toBeNull();
      expect(link.textContent?.trim()).toBe('nav.account');
    });
  });

  // The retry logic itself lives in MessageService (its own spec); this is the
  // layout's part: when to open and close the hub, and when to nudge a retry.
  describe('notification hub wiring', () => {
    let messages: any;
    let auth: any;

    beforeEach(() => {
      messages = TestBed.inject(MessageService) as any;
      auth = TestBed.inject(AuthStore) as any;
    });

    it('opens the hub when the session is authenticated and closes it when it ends', () => {
      auth.isAuthenticated.set(true);
      TestBed.tick();
      expect(messages.openHub).toHaveBeenCalledTimes(1);

      auth.isAuthenticated.set(false);
      TestBed.tick();
      expect(messages.closeHub).toHaveBeenCalled();
    });

    it('nudges a hub retry on navigation', async () => {
      messages.retryHubIfOwed.mockClear();
      await router.navigateByUrl('/search');

      expect(messages.retryHubIfOwed).toHaveBeenCalled();
    });

    it('nudges a hub retry when the visitor comes back to the tab', () => {
      messages.retryHubIfOwed.mockClear();
      document.dispatchEvent(new Event('visibilitychange'));

      expect(messages.retryHubIfOwed).toHaveBeenCalled();
    });

    it('stops listening for the tab coming back once destroyed', () => {
      fixture.destroy();
      messages.retryHubIfOwed.mockClear();
      document.dispatchEvent(new Event('visibilitychange'));

      expect(messages.retryHubIfOwed).not.toHaveBeenCalled();
    });
  });

  describe('school selector metadata', () => {
    let metadata: any;

    beforeEach(() => {
      metadata = TestBed.inject(MetadataService) as any;
    });

    it('loads the schools through the retrying request', () => {
      expect(metadata.getMetadataWithRetry).toHaveBeenCalled();
    });

    it('handles a final failure and asks again on the next navigation', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      metadata.getMetadataWithRetry.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 503 })));
      // The language effect re-loads metadata; this load fails for good.
      (TestBed.inject(I18nService) as any).lang.set('en');
      TestBed.tick();
      expect(consoleError).toHaveBeenCalled();

      metadata.getMetadataWithRetry.mockClear();
      metadata.getMetadataWithRetry.mockReturnValue(of({ schools: [{ id: 1, name: 'NTU' }] }));
      await router.navigateByUrl('/search');

      expect(metadata.getMetadataWithRetry).toHaveBeenCalledTimes(1);
      expect(component.rawSchools).toEqual([{ id: 1, name: 'NTU' }]);

      // Loaded now: later navigations do not ask again.
      metadata.getMetadataWithRetry.mockClear();
      await router.navigateByUrl('/sell');
      expect(metadata.getMetadataWithRetry).not.toHaveBeenCalled();
    });

    it('groups the schools under their cities, in the cities\' order, cityless ones last', () => {
      metadata.getMetadataWithRetry.mockReturnValue(of({
        schools: [
          { id: 1, code: 'NCKU', name: 'NCKU', city: 'TNN' },
          { id: 2, code: 'NTU', name: 'NTU', city: 'TPE' },
          { id: 3, code: 'X', name: 'Nowhere', city: null },
        ],
        cities: [
          { code: 'TPE', name: 'Taipei City', display_name: 'Taipei' },
          { code: 'TNN', name: 'Tainan City' },
        ],
      }));
      (TestBed.inject(I18nService) as any).lang.set('en');
      TestBed.tick();

      expect(component.schools.slice(1).map(o => `${o.group}:${o.value}`))
        .toEqual(['Taipei:NTU', 'Tainan City:NCKU', 'layout.otherCity:X']);
      expect(component.schools[0]).toEqual({ value: '', label: expect.any(String) });
    });

    describe('settling the opening school before the list arrives', () => {
      let school: any;

      beforeEach(() => {
        school = TestBed.inject(SchoolStateService) as any;
        // The list never arrives, so any markReady comes from before it.
        metadata.getMetadataWithRetry.mockReturnValue(NEVER);
        school.markReady.mockClear();
        school.setSchool.mockClear();
      });

      afterEach(() => (component as any).metadataSubscription?.unsubscribe());

      it('settles on all schools at once for a signed-out visitor with no pick', () => {
        (component as any).loadMetadata();
        expect(school.setSchool).toHaveBeenCalledWith('');
        expect(school.markReady).toHaveBeenCalled();
      });

      it('waits for the list when a school was picked by hand', () => {
        school.hasManualPick = () => true;
        (component as any).loadMetadata();
        expect(school.markReady).not.toHaveBeenCalled();
      });

      it('waits for the list when signed in, since the profile may name a school', () => {
        (TestBed.inject(AuthStore) as any).isAuthenticated.set(true);
        (component as any).loadMetadata();
        expect(school.markReady).not.toHaveBeenCalled();
      });
    });
  });

  describe('phone app bar scroll hide/show', () => {
    const stubPhone = (isPhone: boolean) => {
      vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 900px') ? isPhone : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })));
    };

    beforeEach(() => {
      vi.stubGlobal('requestAnimationFrame', (cb: Function) => cb());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      window.scrollY = 0;
    });

    it('stays visible on desktop when scrolling down', () => {
      stubPhone(false);
      window.scrollY = 150;
      window.dispatchEvent(new Event('scroll'));

      expect(component.appBarHidden).toBe(false);
    });

    it('hides after scrolling down past header height on phone', () => {
      stubPhone(true);
      window.scrollY = 100;
      window.dispatchEvent(new Event('scroll'));

      expect(component.appBarHidden).toBe(true);
    });

    it('reveals on upward scroll with 8px hysteresis on phone', () => {
      stubPhone(true);
      window.scrollY = 200;
      window.dispatchEvent(new Event('scroll'));
      expect(component.appBarHidden).toBe(true);

      // Scroll up by only 3px (below 8px hysteresis)
      window.scrollY = 197;
      window.dispatchEvent(new Event('scroll'));
      expect(component.appBarHidden).toBe(true);

      // Scroll up by more (at least 8px total)
      window.scrollY = 185;
      window.dispatchEvent(new Event('scroll'));
      expect(component.appBarHidden).toBe(false);
    });

    it('stays visible at the very top of the page', () => {
      stubPhone(true);
      window.scrollY = 200;
      window.dispatchEvent(new Event('scroll'));
      expect(component.appBarHidden).toBe(true);

      window.scrollY = 0;
      window.dispatchEvent(new Event('scroll'));
      expect(component.appBarHidden).toBe(false);
    });

    it('reveals when an input inside the page receives focus', () => {
      stubPhone(true);
      window.scrollY = 200;
      window.dispatchEvent(new Event('scroll'));
      expect(component.appBarHidden).toBe(true);

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      document.dispatchEvent(new Event('focusin'));

      expect(component.appBarHidden).toBe(false);
      input.remove();
    });
  });
});
