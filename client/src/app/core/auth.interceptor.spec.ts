import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, HttpContext, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, Routes, provideRouter } from '@angular/router';

import { AuthInterceptor, SKIP_AUTH } from './auth.interceptor';
import { ApiUrlInterceptor } from './api-url.interceptor';
import { RetryInterceptor } from './retry.interceptor';
import { AuthStore } from './auth.store';
import { RegionLinkService } from './region-link.service';
import { RegionService } from './region.service';
import { I18nService } from './i18n.service';
import { authGuard } from './auth.guard';
import { environment } from '../../environments/environment';

/** The server's readable "signed in" hint; the session itself is HttpOnly. */
const setSessionHint = () => { document.cookie = 'ub_session=1; Path=/'; };
const clearSessionHint = () => { document.cookie = 'ub_session=; Max-Age=0; Path=/'; };
const hasSessionHint = () => document.cookie.split(';').some(c => c.trim() === 'ub_session=1');
const UNAUTHORIZED = { status: 401, statusText: 'Unauthorized' };

/**
 * The path production actually takes: a visitor opens a page after the
 * 15-minute access cookie has expired, the background requests 401, the
 * interceptor tries POST /auth/refresh/ (the refresh cookie rides along), and
 * the backend either rotates the cookies or refuses.
 *
 * A refusal must sign the visitor out without throwing them off a public page.
 */
describe('AuthInterceptor refresh refusal', () => {
  @Component({ standalone: true, template: 'stub' })
  class StubPage {}

  const TEST_ROUTES: Routes = [
    {
      path: 'tw',
      children: [
        { path: '', component: StubPage },
        { path: 'login', component: StubPage },
        { path: 'account', canActivate: [authGuard], component: StubPage },
      ],
    },
  ];

  const REFRESH_URL = `${environment.backendUrl}/auth/refresh/`;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const listings = (req: { url: string }) => req.url.endsWith('/listings/');

  let httpMock: HttpTestingController;
  let http: HttpClient;
  let router: Router;
  let store: AuthStore;

  /** Set the session hint BEFORE calling this. */
  function build() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        provideRouter(TEST_ROUTES),
        { provide: HTTP_INTERCEPTORS, useClass: ApiUrlInterceptor, multi: true },
        { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
        RegionLinkService,
        { provide: RegionService, useValue: { region: signal('tw') } },
        { provide: I18nService, useValue: { lang: () => 'zh-TW' } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    http = TestBed.inject(HttpClient);
    store = TestBed.inject(AuthStore);
  }

  /** The AuthStore bootstrap fires its own GET /auth/me/; drain whatever is
   *  still queued so a test's assertions are not order-dependent. */
  const drain = () => httpMock.match(() => true).forEach(req => req.flush({}, UNAUTHORIZED));

  beforeEach(() => {
    localStorage.clear();
    clearSessionHint();
  });
  afterEach(() => {
    localStorage.clear();
    clearSessionHint();
  });

  it('never attaches a token of its own to API requests', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    http.get('/listings/').subscribe();
    const req = httpMock.expectOne(listings);
    // The browser sends the HttpOnly cookie; script never sees or sets one.
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush([]);
    drain();
  });

  it('keeps the visitor on a public page when the refresh is refused', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    http.get('/listings/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);

    await settle();
    clearSessionHint();   // the refusal's Set-Cookie clears the session
    httpMock.expectOne(REFRESH_URL)
      .flush({ error: { code: 'auth.errTokenRevoked' } }, UNAUTHORIZED);
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    expect(store.user()).toBeNull();
    // The bug: this used to be '/tw/login'.
    expect(router.url).toBe('/tw');
    drain();
  });

  it('signs out locally even if the refusal did not clear the hint cookie', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    http.get('/listings/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();
    httpMock.expectOne(REFRESH_URL).flush({}, { status: 403, statusText: 'Forbidden' });
    await settle();

    expect(store.isAuthenticated()).toBe(false);
    expect(hasSessionHint()).toBe(false);
    drain();
  });

  it('takes the visitor off a protected page when the refresh is refused', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw/account');
    expect(router.url).toBe('/tw/account');

    http.get('/listings/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);

    await settle();
    httpMock.expectOne(REFRESH_URL).flush({}, UNAUTHORIZED);
    await settle();

    expect(router.url).toBe('/tw/login?returnUrl=%2Ftw%2Faccount');
    drain();
  });

  it('sends the refresh with no body and no token: the cookie is the credential', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    http.get('/listings/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();

    const refresh = httpMock.expectOne(REFRESH_URL);
    expect(refresh.request.method).toBe('POST');
    expect(refresh.request.body).toBeNull();
    expect(refresh.request.headers.has('Authorization')).toBe(false);
    refresh.flush({ code: 'auth.refreshed' });
    httpMock.expectOne(listings).flush([]);
    drain();
  });

  it('does not ask for a refresh without the session hint', async () => {
    // No hint means no refresh cookie either: a refresh could only be refused.
    build();
    await router.navigateByUrl('/tw');

    let status = 0;
    http.get('/messaging/hub-token/').subscribe({ error: err => (status = err.status) });
    httpMock.expectOne(req => req.url.endsWith('/messaging/hub-token/'))
      .flush({ detail: 'not signed in' }, UNAUTHORIZED);
    await settle();

    expect(httpMock.match(REFRESH_URL)).toEqual([]);
    expect(httpMock.match(req => req.url.endsWith('/messaging/hub-token/'))).toEqual([]);
    expect(status).toBe(401);
    drain();
  });

  it('ends a session this tab still believed in when the hint is gone', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');
    expect(store.isAuthenticated()).toBe(true);

    clearSessionHint();   // another tab signed out; its broadcast was missed
    http.get('/listings/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();

    expect(httpMock.match(REFRESH_URL)).toEqual([]);
    expect(store.isAuthenticated()).toBe(false);
    drain();
  });

  it('shares one refresh between concurrent 401s and replays each request once', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    const results: string[] = [];
    for (const path of ['/listings/', '/orders/', '/messaging/conversations/']) {
      http.get<{ path: string }>(path).subscribe({ next: v => results.push(v.path), error: () => results.push('error') });
    }
    for (const path of ['/listings/', '/orders/', '/messaging/conversations/']) {
      httpMock.expectOne(req => req.url.endsWith(path)).flush({}, UNAUTHORIZED);
    }
    await settle();

    // One refresh, not one per 401 — the refresh token is single-use server-side.
    const refreshes = httpMock.match(REFRESH_URL);
    expect(refreshes.length).toBe(1);
    refreshes[0].flush({ code: 'auth.refreshed' });
    await settle();

    for (const path of ['/listings/', '/orders/', '/messaging/conversations/']) {
      const replay = httpMock.match(req => req.url.endsWith(path));
      expect(replay.length).toBe(1);
      replay[0].flush({ path });
    }
    expect(results.sort()).toEqual(['/listings/', '/messaging/conversations/', '/orders/']);
    expect(httpMock.match(REFRESH_URL)).toEqual([]);
    expect(store.isAuthenticated()).toBe(true);
    drain();
  });

  it('starts a new refresh for a 401 that arrives after the last one settled', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    http.get('/listings/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();
    httpMock.expectOne(REFRESH_URL).flush({ code: 'auth.refreshed' });
    httpMock.expectOne(listings).flush([]);

    http.get('/orders/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(req => req.url.endsWith('/orders/')).flush({}, UNAUTHORIZED);
    await settle();
    expect(httpMock.match(REFRESH_URL).length).toBe(1);
    drain();
  });

  it('replays only once: a 401 on the retried request is the answer', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    let status = 0;
    http.get('/listings/').subscribe({ error: err => (status = err.status) });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();
    httpMock.expectOne(REFRESH_URL).flush({ code: 'auth.refreshed' });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();

    expect(status).toBe(401);
    expect(httpMock.match(REFRESH_URL)).toEqual([]);
    drain();
  });

  it.each([
    ['/auth/token/', 'a sign-in with the wrong password'],
    ['/auth/google/', 'a refused Google credential'],
    ['/auth/verify-registration/', 'a dead registration link'],
  ])('passes a 401 from %s straight through (%s)', async (path) => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    let status = 0;
    http.post(path, {}).subscribe({ error: err => (status = err.status) });
    httpMock.expectOne(req => req.url.endsWith(path)).flush({}, UNAUTHORIZED);
    await settle();

    expect(status).toBe(401);
    expect(httpMock.match(REFRESH_URL)).toEqual([]);
    drain();
  });

  it('passes a 401 on a SKIP_AUTH request straight through', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    let status = 0;
    http.get('/listings/', { context: new HttpContext().set(SKIP_AUTH, true) })
      .subscribe({ error: err => (status = err.status) });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();

    expect(status).toBe(401);
    expect(httpMock.match(REFRESH_URL)).toEqual([]);
    drain();
  });

  it('leaves chat requests and their own bearer token alone', async () => {
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    let status = 0;
    const url = 'https://unibooks.app/api/chat/rooms/r1/messages';
    http.get(url, { headers: { Authorization: 'Bearer chat-token' } }).subscribe({ error: err => (status = err.status) });
    const req = httpMock.expectOne(url);
    expect(req.request.headers.get('Authorization')).toBe('Bearer chat-token');
    req.flush('Unauthorized: Invalid token', UNAUTHORIZED);
    await settle();

    expect(status).toBe(401);
    expect(httpMock.match(REFRESH_URL)).toEqual([]);
    expect(store.isAuthenticated()).toBe(true);
    drain();
  });

  it('lets a refresh finish even if everyone waiting on it goes away', async () => {
    // With refCount:true the last subscriber leaving (a component destroyed by
    // navigation) aborted the POST — possibly after the server had already
    // rotated the token, so the browser never stored the new cookies and the
    // next refresh replayed a dead one.
    setSessionHint();
    build();
    await router.navigateByUrl('/tw');

    const subscription = http.get('/listings/').subscribe({ next: () => {}, error: () => {} });
    httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
    await settle();

    subscription.unsubscribe();

    const refresh = httpMock.expectOne(REFRESH_URL);
    expect(refresh.cancelled).toBe(false);
    refresh.flush({ code: 'auth.refreshed' });
    expect(store.isAuthenticated()).toBe(true);
    drain();
  });

  describe('a refresh that fails for reasons unrelated to the session', () => {
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    /** Signed in, one request that has just 401'd and handed off to the
     *  refresh. Fake timers from here on. */
    async function refreshUnderWay() {
      setSessionHint();
      build();
      await router.navigateByUrl('/tw');
      vi.useFakeTimers();

      const outcome: { value?: any; error?: any } = {};
      http.get('/listings/').subscribe({ next: v => (outcome.value = v), error: e => (outcome.error = e) });
      httpMock.expectOne(listings).flush({}, UNAUTHORIZED);
      await tick(0);
      return outcome;
    }

    afterEach(() => vi.useRealTimers());

    it('retries a refresh whose response was lost, well inside the grace window', async () => {
      const outcome = await refreshUnderWay();

      // Connection dropped: the server may already have rotated the token.
      httpMock.expectOne(REFRESH_URL).error(new ProgressEvent('error'));
      await tick(1000);

      // Same refresh cookie again, within the backend's grace window: it
      // answers with the pair it rotated into.
      httpMock.expectOne(REFRESH_URL).flush({ code: 'auth.refreshed' });
      await tick(0);

      httpMock.expectOne(listings).flush({ ok: true });

      expect(outcome.value).toEqual({ ok: true });
      expect(store.isAuthenticated()).toBe(true);
      drain();
    });

    it('rides out the token store being briefly unavailable (503)', async () => {
      const outcome = await refreshUnderWay();

      httpMock.expectOne(REFRESH_URL).flush(
        { error: { code: 'auth.errSessionStoreUnavailable' } },
        { status: 503, statusText: 'Service Unavailable' },
      );
      await tick(1000);
      httpMock.expectOne(REFRESH_URL).flush({ code: 'auth.refreshed' });
      await tick(0);
      httpMock.expectOne(listings).flush({ ok: true });

      expect(outcome.value).toEqual({ ok: true });
      expect(store.isAuthenticated()).toBe(true);
      drain();
    });

    it('gives up after its retries without signing the visitor out', async () => {
      const outcome = await refreshUnderWay();
      const unavailable = { status: 503, statusText: 'Service Unavailable' };

      httpMock.expectOne(REFRESH_URL).flush({}, unavailable);
      await tick(1000);
      httpMock.expectOne(REFRESH_URL).flush({}, unavailable);
      await tick(2000);
      httpMock.expectOne(REFRESH_URL).flush({}, unavailable);
      await tick(5000);

      expect(httpMock.match(REFRESH_URL)).toEqual([]);
      expect(outcome.error?.status).toBe(503);
      // An outage is not a verdict on the session: keep it for the next try.
      expect(store.isAuthenticated()).toBe(true);
      expect(hasSessionHint()).toBe(true);
      expect(router.url).toBe('/tw');
      drain();
    });

    it('does not retry a refresh the server actually refused', async () => {
      await refreshUnderWay();

      httpMock.expectOne(REFRESH_URL).flush({}, UNAUTHORIZED);
      await tick(5000);

      expect(httpMock.match(REFRESH_URL)).toEqual([]);
      expect(store.isAuthenticated()).toBe(false);
      drain();
    });
  });
});

/**
 * The app's real interceptor order: ApiUrl -> Retry -> Auth. RetryInterceptor
 * wraps AuthInterceptor, so anything AuthInterceptor lets escape gets the whole
 * chain retried — including a refresh failure it has already retried itself.
 */
describe('AuthInterceptor inside the real interceptor chain', () => {
  const REFRESH_URL = `${environment.backendUrl}/auth/refresh/`;
  let httpMock: HttpTestingController;
  let http: HttpClient;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();
    setSessionHint();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        provideRouter([{ path: 'tw', children: [] }]),
        { provide: HTTP_INTERCEPTORS, useClass: ApiUrlInterceptor, multi: true },
        { provide: HTTP_INTERCEPTORS, useClass: RetryInterceptor, multi: true },
        { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
        RegionLinkService,
        { provide: RegionService, useValue: { region: signal('tw') } },
        { provide: I18nService, useValue: { lang: () => 'zh-TW' } },
        // Just the surface the interceptor uses. The real AuthStore also
        // fetches and re-fetches the profile on its own schedule, which would
        // add refresh attempts of its own and blur what this counts.
        {
          provide: AuthStore,
          useValue: {
            isAuthenticated: () => true,
            endSession: () => clearSessionHint(),
          },
        },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    http = TestBed.inject(HttpClient);
    router = TestBed.inject(Router);
    await router.navigateByUrl('/tw');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    clearSessionHint();
  });

  it('makes one bounded set of refresh attempts, not one per outer retry', async () => {
    http.get('/listings/').subscribe({ error: () => {} });
    const unavailable = { status: 503, statusText: 'Service Unavailable' };
    let refreshAttempts = 0;

    // Answer every request for a while: listings with 401 (expired access
    // cookie), every refresh with 503 (token store down).
    for (let i = 0; i < 40; i++) {
      for (const req of httpMock.match(r => r.url.endsWith('/listings/'))) {
        req.flush({}, UNAUTHORIZED);
      }
      for (const req of httpMock.match(REFRESH_URL)) {
        refreshAttempts++;
        req.flush({}, unavailable);
      }
      httpMock.match(() => true).forEach(req => req.flush({}, UNAUTHORIZED));
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(refreshAttempts).toBe(3);
  });
});
