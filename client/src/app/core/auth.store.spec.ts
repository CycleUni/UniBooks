import { TestBed } from '@angular/core/testing';
import { SELL_DRAFT_STORAGE_KEY } from './storage-keys';
import { RecentSearches } from './search-suggestions';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { sentry } from './sentry';
import { AuthStore } from './auth.store';
import { RegionLinkService } from './region-link.service';
import { RegionService } from './region.service';
import { Meta, Title } from '@angular/platform-browser';
import { Component, inject, signal } from '@angular/core';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, Routes, provideRouter } from '@angular/router';
import { authGuard } from './auth.guard';
import { AUTH_CHANNEL, AUTH_PING_KEY } from './auth.store';

/** The server's readable "signed in" hint (server/src/lib/session.ts). The
 *  session itself is HttpOnly cookies these tests never see, like the app. */
function setSessionHint(): void {
  document.cookie = 'ub_session=1; Path=/';
}
function clearSessionHint(): void {
  document.cookie = 'ub_session=; Max-Age=0; Path=/';
}
function hasSessionHintCookie(): boolean {
  return document.cookie.split(';').some(c => c.trim() === 'ub_session=1');
}
/** Every key the store could have written; none may hold a token. */
function storedValues(): string[] {
  const values: string[] = [];
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) values.push(`${store.key(i)}=${store.getItem(store.key(i)!)}`);
  }
  return values;
}
/** What another tab of this browser would post. */
function otherTab(type: 'login' | 'logout'): Promise<void> {
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.postMessage({ type });
  channel.close();
  return new Promise(resolve => setTimeout(resolve, 20));
}

describe('AuthStore', () => {
  let authStore: AuthStore;
  let mockRegionService: any;

  beforeEach(() => {
    mockRegionService = {
      region: signal('tw')
    };

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule],
      providers: [
        AuthStore,
        RegionLinkService,
        { provide: RegionService, useValue: mockRegionService },
        Title,
        Meta
      ]
    });
    
    authStore = TestBed.inject(AuthStore);
  });

  it('tells Sentry the signed-in user by id only, and clears it on sign-out', () => {
    vi.spyOn(sentry, 'setUser').mockImplementation(() => undefined);
    (authStore as any)._user.set({ id: 7, email: 'someone@example.edu', display_name: 'Someone' });
    TestBed.tick();
    expect(sentry.setUser).toHaveBeenLastCalledWith({ id: '7' });

    (authStore as any)._user.set(null);
    TestBed.tick();
    expect(sentry.setUser).toHaveBeenLastCalledWith(null);
  });

  describe('isVerifiedIn()', () => {
    it('should return true for region match regardless of case (TW vs tw)', () => {
      const user = {
        id: 1,
        email: 'test@test.com',
        verifications: [
          { region: 'TW', school: 1, edu_email: 'test@edu.tw', verified_at: '2026-08-28T12:27:44Z' }
        ]
      };
      
      (authStore as any)._user.set(user);

      expect(authStore.isVerifiedIn('tw')).toBe(true);
      expect(authStore.isVerifiedIn('TW')).toBe(true);
    });

    it('should return false if verified_at is null', () => {
      const user = {
        id: 1,
        email: 'test@test.com',
        verifications: [
          { region: 'TW', school: 1, edu_email: 'test@edu.tw', verified_at: null }
        ]
      };
      
      (authStore as any)._user.set(user);

      expect(authStore.isVerifiedIn('tw')).toBe(false);
      expect(authStore.isVerifiedIn('TW')).toBe(false);
    });
  });
});

/**
 * Regression cover for the production bug where opening the PUBLIC homepage
 * with stale tokens threw the visitor to /login the moment the backend
 * answered the background bootstrap GET /auth/me/.
 *
 * These drive a real Router over a real route table, because the thing under
 * test is precisely "which page am I on, and may a signed-out visitor be
 * here?" — a navigate() spy alone cannot tell those cases apart.
 */
describe('AuthStore session expiry', () => {
  @Component({ standalone: true, template: 'stub' })
  class StubPage {}

  /** A lazy chunk a test can hold open, standing in for loadComponent's
   *  download — the window in which a navigation has passed its guards but has
   *  not committed. */
  function heldChunk() {
    let release!: () => void;
    const promise = new Promise<typeof StubPage>(resolve => (release = () => resolve(StubPage)));
    return { promise, release };
  }

  /** A guard verdict a test can hold open, then release with any result. */
  function heldVerdict() {
    let release!: (verdict: boolean | 'redirect-home') => void;
    const promise = new Promise<boolean | 'redirect-home'>(resolve => (release = resolve));
    return { promise, release };
  }

  /** A lazy chunk that fails to download once released. */
  function failingChunk() {
    let fail!: () => void;
    const promise = new Promise<typeof StubPage>((_, reject) => (fail = () => reject(new Error('chunk failed'))));
    return { promise, fail };
  }

  let slowAccount = heldChunk();
  let slowPublic = heldChunk();
  let heldGuard = heldVerdict();
  let brokenChunk = failingChunk();

  /** Fresh Route objects per test: Angular caches a loaded component on the
   *  Route object itself, so a shared table would only ever hold a chunk open
   *  in the first test that touched it. */
  function testRoutes(): Routes {
    return [
      {
        path: 'tw',
        children: [
          { path: '', component: StubPage },
          { path: 'login', component: StubPage },
          { path: 'account', canActivate: [authGuard], component: StubPage },
          { path: 'slow-account', canActivate: [authGuard], loadComponent: () => slowAccount.promise },
          { path: 'slow-public', loadComponent: () => slowPublic.promise },
          {
            // Resolves to whatever the test releases: true, false (cancel), or
            // a redirect to the public home page.
            path: 'held',
            canActivate: [() => {
              const guardRouter = inject(Router);
              return heldGuard.promise.then(v => (v === 'redirect-home' ? guardRouter.parseUrl('/tw') : v));
            }],
            component: StubPage,
          },
          { path: 'broken', loadComponent: () => brokenChunk.promise },
        ],
      },
    ];
  }

  let httpMock: HttpTestingController;
  let router: Router;

  /** Set the session hint BEFORE this: the bootstrap fetch is scheduled from
   *  the AuthStore constructor. */
  function build(): AuthStore {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        provideRouter(testRoutes()),
        RegionLinkService,
        { provide: RegionService, useValue: { region: signal('tw') } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    return TestBed.inject(AuthStore);
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => {
    localStorage.clear();
    clearSessionHint();
    slowAccount = heldChunk();
    slowPublic = heldChunk();
    heldGuard = heldVerdict();
    brokenChunk = failingChunk();
  });

  /** Put a signed-in visitor on /tw/account with the bootstrap profile loaded. */
  async function signedInOnAccount(): Promise<AuthStore> {
    setSessionHint();
    const store = build();
    await router.navigateByUrl('/tw/account');
    await settle();
    httpMock.expectOne('/auth/me?include=listings,subscriptions').flush({ id: 1, email: 'a@b.c' });
    return store;
  }
  afterEach(() => {
    localStorage.clear();
    clearSessionHint();
  });

  it('stays on a public page when the session turns out to be dead', async () => {
    setSessionHint();
    const store = build();

    // Optimistic: the mere presence of the hint marks the session live, which is
    // what lets the homepage render signed-in before the backend disagrees.
    expect(store.isAuthenticated()).toBe(true);

    await router.navigateByUrl('/tw');
    await settle();
    httpMock.expectOne('/auth/me').flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    expect(store.user()).toBeNull();
    expect(hasSessionHintCookie()).toBe(false);
    // The bug: this used to be '/tw/login'.
    expect(router.url).toBe('/tw');
  });

  it('leaves a protected page for the sign-in page, carrying returnUrl', async () => {
    setSessionHint();
    const store = build();

    // The stale hint gets them past authGuard, exactly as on a cold deep link.
    await router.navigateByUrl('/tw/account');
    expect(router.url).toBe('/tw/account');

    await settle();
    httpMock.expectOne('/auth/me?include=listings,subscriptions').flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    expect(router.url).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
  });

  it('waits for a deep link that already passed its guard, then sends it to sign in', async () => {
    // A bookmarked /account opened with expired tokens: authGuard admits it on
    // the stale token, and the page's chunk is still downloading when the
    // backend refuses the session. routerState at that moment is the router's
    // empty initial state, so deciding then would find nothing to leave.
    setSessionHint();
    const store = build();

    const navigation = router.navigateByUrl('/tw/slow-account');
    await settle();
    expect(router.currentNavigation()).not.toBeNull();

    httpMock.expectOne('/auth/me').flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    await settle();
    expect(store.isAuthenticated()).toBe(false);

    slowAccount.release();
    await navigation;
    await settle();
    await settle();

    expect(router.url).toBe('/tw/login?returnUrl=%2Ftw%2Fslow-account');
  });

  it('lets a visitor leaving a protected page for a public one arrive there', async () => {
    setSessionHint();
    const store = build();

    await router.navigateByUrl('/tw/account');
    await settle();
    httpMock.expectOne('/auth/me?include=listings,subscriptions').flush({ id: 1, email: 'a@b.c' });

    // Mid-navigation, routerState still says /tw/account. Deciding from that
    // would pull the visitor back to /login away from the page they chose.
    const navigation = router.navigateByUrl('/tw/slow-public');
    await settle();
    store.endSession();

    slowPublic.release();
    await navigation;
    await settle();
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    expect(router.url).toBe('/tw/slow-public');
  });

  it('logout() lands on the sign-in page wherever it was called from', async () => {
    setSessionHint();
    const store = build();

    await router.navigateByUrl('/tw');
    await settle();
    httpMock.expectOne('/auth/me').flush({ id: 1, email: 'a@b.c' });

    store.logout().subscribe();
    httpMock.expectOne('/auth/logout').flush({});
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    expect(router.url).toBe('/tw/login');
  });

  it("logout() forgets what this person typed (sell draft, recent searches), for whoever uses the browser next", async () => {
    setSessionHint();
    const store = build();
    await router.navigateByUrl('/tw');
    await settle();
    httpMock.expectOne('/auth/me').flush({ id: 1, email: 'a@b.c' });
    localStorage.setItem(SELL_DRAFT_STORAGE_KEY, '{"version":1}');
    const recent = TestBed.inject(RecentSearches);
    recent.add('Organic Chemistry');

    store.logout().subscribe();
    httpMock.expectOne('/auth/logout').flush({});
    await settle();

    expect(localStorage.getItem(SELL_DRAFT_STORAGE_KEY)).toBeNull();
    expect(recent.items()).toEqual([]);
  });

  it('logout() still lands there when the server refuses to revoke the token', async () => {
    setSessionHint();
    const store = build();

    await router.navigateByUrl('/tw');
    await settle();
    httpMock.expectOne('/auth/me').flush({ id: 1, email: 'a@b.c' });

    store.logout().subscribe();
    httpMock.expectOne('/auth/logout').flush({}, { status: 500, statusText: 'Server Error' });
    await settle();

    expect(router.url).toBe('/tw/login');
  });

  it('decides after a redirecting navigation lands, not when it is cancelled for the redirect', async () => {
    // A guard redirect emits NavigationCancel and then starts a second
    // navigation. Deciding at the cancel would read /tw/account and pull the
    // visitor to /login away from the public page the redirect is taking them to.
    const store = await signedInOnAccount();

    const navigation = router.navigateByUrl('/tw/held');
    await settle();
    store.endSession();
    heldGuard.release('redirect-home');
    await navigation;
    for (let i = 0; i < 4; i++) await settle();

    expect(router.url).toBe('/tw');
  });

  it('still decides when the pending navigation is cancelled', async () => {
    const store = await signedInOnAccount();

    const navigation = router.navigateByUrl('/tw/held');
    await settle();
    store.endSession();
    heldGuard.release(false);
    await navigation;
    await settle();
    await settle();

    // The cancelled navigation left them where they were, which they can no
    // longer see.
    expect(router.url).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
  });

  it('still decides when the pending navigation errors', async () => {
    const store = await signedInOnAccount();

    const navigation = router.navigateByUrl('/tw/broken').catch(() => false);
    await settle();
    store.endSession();
    brokenChunk.fail();
    await navigation;
    await settle();
    await settle();

    expect(router.url).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
  });

  it('replaces the history entry, so Back does not return to the lost page', async () => {
    const store = await signedInOnAccount();
    const navigateByUrl = vi.spyOn(router, 'navigateByUrl');

    store.endSession();
    await settle();

    expect(navigateByUrl).toHaveBeenCalledTimes(1);
    expect(navigateByUrl).toHaveBeenCalledWith(expect.anything(), { replaceUrl: true });
  });

  it('makes one decision when the session is ended several times during one navigation', async () => {
    setSessionHint();
    const store = build();

    const navigation = router.navigateByUrl('/tw/slow-account');
    await settle();
    const navigateByUrl = vi.spyOn(router, 'navigateByUrl');
    store.endSession();
    store.endSession();
    store.endSession();

    slowAccount.release();
    await navigation;
    await settle();
    await settle();

    expect(navigateByUrl).toHaveBeenCalledTimes(1);
    expect(router.url).toBe('/tw/login?returnUrl=%2Ftw%2Fslow-account');
    httpMock.match(() => true).forEach(req => req.flush({}));
  });

  it('leaves the visitor alone if they signed back in while the navigation was pending', async () => {
    setSessionHint();
    const store = build();

    const navigation = router.navigateByUrl('/tw/slow-account');
    await settle();
    store.endSession();
    store.markSignedIn();

    slowAccount.release();
    await navigation;
    await settle();
    await settle();

    expect(router.url).toBe('/tw/slow-account');
    httpMock.match(() => true).forEach(req => req.flush({ id: 1, email: 'a@b.c' }));
  });

  it('follows a sign-out in another tab off a protected page', async () => {
    const store = await signedInOnAccount();

    // The other tab's sign-out cleared the shared cookies; this tab only hears
    // the broadcast. Earlier tests in this file built stores of their own: if
    // any still listened, this would reach a destroyed injector (NG0205).
    clearSessionHint();
    await otherTab('logout');

    expect(store.isAuthenticated()).toBe(false);
    expect(store.user()).toBeNull();
    expect(router.url).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
  });

  it('picks up a sign-in in another tab and loads that profile', async () => {
    const store = build();
    await router.navigateByUrl('/tw');
    expect(store.isAuthenticated()).toBe(false);

    setSessionHint();
    await otherTab('login');

    expect(store.isAuthenticated()).toBe(true);
    httpMock.expectOne('/auth/me').flush({ id: 2, email: 'b@c.d' });
    expect(store.user()?.id).toBe(2);
  });

  it('reports the profile as settled once the request ends, whether or not it brought a profile', async () => {
    const store = build();
    await router.navigateByUrl('/tw');
    expect(store.profileSettled()).toBe(false);

    setSessionHint();
    await otherTab('login');
    expect(store.profileSettled()).toBe(false);
    httpMock.expectOne('/auth/me').flush({ id: 2, email: 'b@c.d' });
    expect(store.profileSettled()).toBe(true);
  });

  it('reports the profile as settled when the request fails with a server error', async () => {
    const store = build();
    await router.navigateByUrl('/tw');
    setSessionHint();
    await otherTab('login');

    httpMock.expectOne('/auth/me').flush({}, { status: 500, statusText: 'Server Error' });
    expect(store.user()).toBeNull();
    expect(store.profileSettled()).toBe(true);
  });

  it('tells other tabs when it signs in and out, with no token in the message', async () => {
    const listener = new BroadcastChannel(AUTH_CHANNEL);
    const heard: unknown[] = [];
    listener.onmessage = e => heard.push(e.data);
    try {
      const store = build();
      await router.navigateByUrl('/tw');

      store.login('a@b.c', 'pw').subscribe();
      setSessionHint();   // what the server's Set-Cookie does
      httpMock.expectOne('/auth/login').flush({ code: 'auth.loginSuccess', user_id: 1 });
      httpMock.expectOne('/auth/me').flush({ id: 1, email: 'a@b.c' });

      store.logout().subscribe();
      httpMock.expectOne('/auth/logout').flush({ code: 'auth.logoutSuccess' });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(heard).toEqual([{ type: 'login' }, { type: 'logout' }]);
    } finally {
      listener.close();
    }
  });

  it('does not answer another tab\'s sign-out with one of its own', async () => {
    const listener = new BroadcastChannel(AUTH_CHANNEL);
    const heard: unknown[] = [];
    listener.onmessage = e => heard.push(e.data);
    try {
      await signedInOnAccount();
      await otherTab('logout');
      // A re-broadcast would bounce between tabs for ever.
      expect(heard).toEqual([{ type: 'logout' }]);
    } finally {
      listener.close();
    }
  });

  it('stops listening for other tabs once its injector is destroyed', async () => {
    const store = await signedInOnAccount();
    const endSession = vi.spyOn(store, 'endSession');

    TestBed.resetTestingModule();
    await otherTab('logout');

    // A store left listening would act on a destroyed injector (NG0205).
    expect(endSession).not.toHaveBeenCalled();
  });

  it('drops its deferred profile fetch once its injector is destroyed', () => {
    // The bootstrap fetch waits one macrotask after construction. If the
    // injector goes first (a test ending, an app torn down) that callback used
    // to run anyway and throw NG0205 from runInInjectionContext.
    vi.useFakeTimers();
    try {
      setSessionHint();
      build();
      TestBed.resetTestingModule();
      expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not bring the user back when their profile lands after they signed out', async () => {
    setSessionHint();
    const store = build();
    await router.navigateByUrl('/tw');
    await settle();
    const bootstrapProfile = httpMock.expectOne('/auth/me');

    store.logout().subscribe();
    httpMock.expectOne('/auth/logout').flush({ code: 'auth.logoutSuccess' });
    await settle();
    bootstrapProfile.flush({ id: 1, email: 'a@b.c' });

    expect(store.isAuthenticated()).toBe(false);
    expect(store.user()).toBeNull();
  });
});

/**
 * A session can be intact while its profile failed to load — a cold serverless
 * start failing the first /auth/me/ (or the refresh behind it). Without the
 * profile the header has no name and staff have no admin link, which reads as
 * signed out until the page is reloaded.
 */
describe('AuthStore profile after a transient failure', () => {
  @Component({ standalone: true, template: 'stub' })
  class StubPage {}

  let httpMock: HttpTestingController;
  let router: Router;
  let store: AuthStore;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const profileRequests = () => httpMock.match('/auth/me');
  const unavailable = { status: 503, statusText: 'Service Unavailable' };

  /** Signed in (hint cookie present), bootstrap /auth/me/ in the air, fake timers on. */
  async function signedInWithProfileOut() {
    setSessionHint();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        provideRouter([{ path: 'tw', children: [{ path: '', component: StubPage }, { path: 'search', component: StubPage }] }]),
        RegionLinkService,
        { provide: RegionService, useValue: { region: signal('tw') } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    store = TestBed.inject(AuthStore);
    await router.navigateByUrl('/tw');
    await settle();
    vi.useFakeTimers();
  }

  beforeEach(() => {
    localStorage.clear();
    clearSessionHint();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    clearSessionHint();
  });

  it('fetches the profile again on its own after a transient failure', async () => {
    await signedInWithProfileOut();

    const [first] = profileRequests();
    first.flush({}, unavailable);
    expect(store.isAuthenticated()).toBe(true);
    expect(store.user()).toBeNull();

    // Nobody clicks anything.
    await vi.advanceTimersByTimeAsync(3000);
    const [second] = profileRequests();
    second.flush({ id: 1, email: 'staff@x.y', role: 'staff' });

    expect(store.user()?.role).toBe('staff');
  });

  it('keeps trying on a backing-off schedule, then stops', async () => {
    await signedInWithProfileOut();
    profileRequests()[0].flush({}, unavailable);

    let attempts = 0;
    for (let second = 0; second < 120; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      for (const req of profileRequests()) {
        attempts++;
        req.flush({}, unavailable);
      }
    }

    expect(attempts).toBe(3);
  });

  it('tries again when the visitor navigates, even after the schedule has run out', async () => {
    await signedInWithProfileOut();
    profileRequests()[0].flush({}, unavailable);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      profileRequests().forEach(req => req.flush({}, unavailable));
    }
    expect(profileRequests()).toEqual([]);

    await router.navigateByUrl('/tw/search');
    await vi.advanceTimersByTimeAsync(0);

    const retried = profileRequests();
    expect(retried.length).toBe(1);
    retried[0].flush({ id: 1, email: 'a@b.c' });
    expect(store.user()).not.toBeNull();
  });

  it('tries again when the visitor comes back to the tab', async () => {
    await signedInWithProfileOut();
    profileRequests()[0].flush({}, unavailable);

    document.dispatchEvent(new Event('visibilitychange'));

    expect(profileRequests().length).toBe(1);
  });

  it('does not stack a second request while one is already out', async () => {
    await signedInWithProfileOut();

    // Bootstrap request still pending; a navigation asks for the profile too.
    await router.navigateByUrl('/tw/search');
    await vi.advanceTimersByTimeAsync(0);

    expect(profileRequests().length).toBe(1);
  });

  it('does not retry an answer that will not change by waiting', async () => {
    await signedInWithProfileOut();
    profileRequests()[0].flush({}, { status: 404, statusText: 'Not Found' });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(profileRequests()).toEqual([]);
  });

  it('gives the next session a full retry schedule of its own', async () => {
    await signedInWithProfileOut();
    // First session: fail, then fail its first scheduled retry as well, so it
    // is two steps into its schedule when it ends.
    profileRequests()[0].flush({}, unavailable);
    await vi.advanceTimersByTimeAsync(3000);
    profileRequests()[0].flush({}, unavailable);

    store.logout().subscribe();
    httpMock.match(() => true).forEach(req => req.flush({}));

    // Signed straight back in; its profile fails too.
    setSessionHint();
    store.markSignedIn();
    profileRequests()[0].flush({}, unavailable);

    let attempts = 0;
    for (let second = 0; second < 120; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      for (const req of profileRequests()) {
        attempts++;
        req.flush({}, unavailable);
      }
    }

    expect(attempts).toBe(3);
  });

  it('stops retrying once the visitor signs out', async () => {
    await signedInWithProfileOut();
    profileRequests()[0].flush({}, unavailable);

    store.logout().subscribe();
    httpMock.match(() => true).forEach(req => req.flush({}));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(profileRequests()).toEqual([]);
  });
});


/**
 * The session is HttpOnly cookies the server sets; page JavaScript must never
 * hold a token — not in storage, not in this store.
 */
describe('AuthStore cookie session', () => {
  @Component({ standalone: true, template: 'stub' })
  class StubPage {}

  let httpMock: HttpTestingController;
  let router: Router;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  function build(): AuthStore {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        provideRouter([{ path: 'tw', children: [{ path: '', component: StubPage }, { path: 'login', component: StubPage }] }]),
        RegionLinkService,
        { provide: RegionService, useValue: { region: signal('tw') } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    return TestBed.inject(AuthStore);
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearSessionHint();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearSessionHint();
  });

  it('removes the token pair an older build left in localStorage', () => {
    localStorage.setItem('access_token', 'old-access');
    localStorage.setItem('refresh_token', 'old-refresh');
    localStorage.setItem('theme', 'dark');

    const store = build();

    expect(localStorage.getItem('access_token')).toBeNull();
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(localStorage.getItem('theme')).toBe('dark');
    // A leftover token is not a session: only the server's hint cookie is.
    expect(store.isAuthenticated()).toBe(false);
  });

  it('asks nothing of the server without the session hint', async () => {
    const store = build();
    await router.navigateByUrl('/tw');
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    httpMock.expectNone('/auth/me');
  });

  it('is signed in once the hint is there and /auth/me/ answers', async () => {
    setSessionHint();
    const store = build();
    await router.navigateByUrl('/tw');
    await settle();

    httpMock.expectOne('/auth/me').flush({ id: 5, email: 'a@b.c' });
    expect(store.isAuthenticated()).toBe(true);
    expect(store.user()?.id).toBe(5);
  });

  it.each([
    ['password', (store: AuthStore) => store.login('a@b.c', 'pw'), '/auth/login'],
    ['Google', (store: AuthStore) => store.loginWithGoogle('google-credential'), '/auth/google'],
    ['registration link', (store: AuthStore) => store.verifyRegistration('mail-token', 'pw'), '/auth/verify-registration'],
  ])('never writes a token to storage on a %s sign-in', async (_how, signIn, url) => {
    const store = build();
    await router.navigateByUrl('/tw');

    signIn(store).subscribe();
    setSessionHint();
    // Even a server that still echoed the old body must not get it stored.
    httpMock.expectOne(url).flush({
      code: 'auth.loginSuccess', user_id: 1, user: { is_verified: true },
      access: 'leaked-access', refresh: 'leaked-refresh',
    });
    httpMock.expectOne('/auth/me').flush({ id: 1, email: 'a@b.c' });

    expect(store.isAuthenticated()).toBe(true);
    const stored = storedValues().join('\n');
    expect(stored).not.toContain('leaked-access');
    expect(stored).not.toContain('leaked-refresh');
    // Nor kept in memory: no string field of the store holds it.
    const strings = Object.values(store).filter((v): v is string => typeof v === 'string');
    expect(strings.join('\n')).not.toContain('leaked-');
  });

  it('does not count a sign-in response without the success code as signed in', async () => {
    const store = build();
    await router.navigateByUrl('/tw');

    store.login('a@b.c', 'pw').subscribe();
    httpMock.expectOne('/auth/login').flush({ code: 'auth.somethingElse' });

    expect(store.isAuthenticated()).toBe(false);
    httpMock.expectNone('/auth/me');
  });

  it('logout() revokes on the server and clears every trace here', async () => {
    setSessionHint();
    const store = build();
    await router.navigateByUrl('/tw');
    await settle();
    httpMock.expectOne('/auth/me').flush({ id: 1, email: 'a@b.c' });
    const generation = store.sessionGeneration;

    store.logout().subscribe();
    const req = httpMock.expectOne('/auth/logout');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ code: 'auth.logoutSuccess' });
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    expect(store.user()).toBeNull();
    expect(store.sessionGeneration).not.toBe(generation);
    expect(hasSessionHintCookie()).toBe(false);
    expect(storedValues().filter(v => !v.startsWith(`${AUTH_PING_KEY}=`))).toEqual([]);
    expect(router.url).toBe('/tw/login');
  });

  it('logout() signs out locally when the server already ended the session', async () => {
    // An account deletion: DELETE /auth/me/ cleared the cookies, so there is
    // nothing left to revoke and a POST would only be refused.
    setSessionHint();
    const store = build();
    await router.navigateByUrl('/tw');
    await settle();
    httpMock.expectOne('/auth/me').flush({ id: 1, email: 'a@b.c' });

    clearSessionHint();
    store.logout().subscribe();
    await settle();

    httpMock.expectNone('/auth/logout');
    expect(store.isAuthenticated()).toBe(false);
    expect(store.user()).toBeNull();
    expect(router.url).toBe('/tw/login');
  });

  it('fetches bare /auth/me on non-account routes and includes listings/subscriptions on /account', async () => {
    // 1. 在非 account 頁面啟動：送出無參數的 bare /auth/me
    setSessionHint();
    const store = build();
    await router.navigateByUrl('/tw');
    await settle();
    const bareReq = httpMock.expectOne('/auth/me');
    expect(bareReq.request.params.get('include')).toBeNull();
    bareReq.flush({ id: 1, email: 'user@example.com' });
    expect(store.user()?.email).toBe('user@example.com');

    // 2. 在 /tw/account 頁面請求 Profile：送出包含 listings,subscriptions 的請求
    store.requestProfile(true);
    const includeReq = httpMock.expectOne('/auth/me?include=listings,subscriptions');
    expect(includeReq.request.params.get('include')).toBe('listings,subscriptions');
    includeReq.flush({ id: 1, email: 'user@example.com', myListingCounts: { all: 0 } });
  });
});
