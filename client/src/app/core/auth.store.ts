import { DestroyRef, Injectable, Injector, signal, inject, untracked, runInInjectionContext, effect } from '@angular/core';
import { sentry } from './sentry';
import { HttpClient, HttpParams } from '@angular/common/http';
import { tap, catchError, filter, take, finalize, shareReplay, switchMap } from 'rxjs/operators';
import { Observable, of, throwError } from 'rxjs';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationSkipped, Router } from '@angular/router';
import { GoogleAnalyticsService } from './services/google-analytics.service';
import { PushService } from './services/push.service';
import { RegionLinkService } from './region-link.service';
import { isSameRegion, stripRegionPrefix } from './region-path';
import { isUserVerifiedIn } from './verification';
import { signedOutRedirectFor } from './signed-out-redirect';
import { isTransientHttpFailure } from './http-failure';

export interface RegionVerification {
  region: string;
  school: any;
  /** The school's short code, unique only within `region`. */
  school_code?: string;
  school_name?: string;
  edu_email: string;
  verified_at: string | null;
}

export interface PasskeyItem {
  id: string;
  name: string;
  aaguid?: string | null;
  provider?: string | null;
  icon_light?: string | null;
  icon_dark?: string | null;
  created_at: string;
  last_used_at: string | null;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: boolean | number;
}

export function isUserCancellation(err: unknown): boolean {
  if (!err) return false;
  const directName = (err as any).name;
  const directCode = (err as any).code;
  if (directName === 'NotAllowedError' || directName === 'AbortError' || directCode === 'ERROR_CEREMONY_ABORTED') return true;
  const causeName = (err as any).cause?.name;
  const causeCode = (err as any).cause?.code;
  if (causeName === 'NotAllowedError' || causeName === 'AbortError' || causeCode === 'ERROR_CEREMONY_ABORTED') return true;
  return false;
}

export const webauthnBrowser = {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
};

/** What the account may do: 'staff' reaches the admin area, 'admin' also manages staff and advertisers. */
export type UserRole = 'user' | 'staff' | 'admin';

/** Staff access: the admin area at all (role 'staff' or 'admin'). */
export function hasStaffAccess(user: { role?: unknown } | null | undefined): boolean {
  return user?.role === 'staff' || user?.role === 'admin';
}

/** Full admin: everything staff can do, plus staff and advertiser management. */
export function isAdminUser(user: { role?: unknown } | null | undefined): boolean {
  return user?.role === 'admin';
}

export interface AuthUser {
  id: string | number;
  email: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  is_active?: boolean;
  average_rating?: number;
  review_count?: number;
  no_show_count?: number;
  has_password?: boolean;
  avatar_url?: string;
  show_avatar?: boolean;
  is_google_linked?: boolean;
  role?: UserRole;
  verifications?: RegionVerification[];
  /** The language the site was last used in, as last reported. */
  site_language?: string;
  /** The verified region the site was last used in ('TW'), or '' when none
   *  is saved or its verification has ended. */
  site_region?: string;
  /** Codes of the regions the user has a verified school email in ('TW'). */
  regions?: string[];
  [key: string]: unknown;
}

/**
 * The readable `ub_session=1` cookie the server sets next to the HttpOnly
 * session cookies (server/src/lib/session.ts). It is not a credential — the
 * tokens themselves never reach page JavaScript — it only says whether there
 * is a session worth asking /auth/me/ about.
 */
export const SESSION_HINT_COOKIE = 'ub_session';

export function hasSessionHint(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return document.cookie.split(';').some(c => c.trim() === `${SESSION_HINT_COOKIE}=1`);
  } catch {
    return false;
  }
}

/**
 * The readable `ub_access=1` cookie, which lapses on the browser's clock just
 * before the HttpOnly access cookie. Signed in without it means the access
 * cookie is gone or about to be: refresh before calling the API.
 */
export const ACCESS_HINT_COOKIE = 'ub_access';

export function hasAccessHint(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return document.cookie.split(';').some(c => c.trim() === `${ACCESS_HINT_COOKIE}=1`);
  } catch {
    return false;
  }
}

/** Drop the hint cookie on this side too, so a sign-out whose request never
 *  reached the server does not come back as "signed in" on the next load. */
function clearSessionHint(): void {
  if (typeof document === 'undefined') return;
  try {
    document.cookie = `${SESSION_HINT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
    document.cookie = `${SESSION_HINT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
    document.cookie = `${ACCESS_HINT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
    document.cookie = `${ACCESS_HINT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
  } catch {
    // Cookies disabled: nothing was there to clear.
  }
}

/** Cross-tab sign-in / sign-out notices. Carries the event only, never a token. */
export const AUTH_CHANNEL = 'ub-auth';
/** Fallback for browsers without BroadcastChannel: a localStorage key whose
 *  value is just the event name and a timestamp. */
export const AUTH_PING_KEY = 'ub_auth_event';
type AuthEvent = 'login' | 'logout';

/** Keys an older build kept the JWT pair under; removed once on startup. */
const LEGACY_TOKEN_KEYS = ['access_token', 'refresh_token'];

/** True for a sign-in response: the server sets the session cookies and says so. */
function isLoginSuccess(response: any): boolean {
  return response?.code === 'auth.loginSuccess';
}

@Injectable({
  providedIn: 'root'
})
export class AuthStore {
  private readonly _isAuthenticated = signal<boolean>(false);
  private readonly _user = signal<AuthUser | null>(null);

  /** True once the session's profile request has ended — with the profile, an
   *  error, or because the session ended. Pages that must not guess at what
   *  the profile will say (the opening school) wait on this, not on a timer. */
  private readonly _profileSettled = signal<boolean>(false);
  readonly profileSettled = this._profileSettled.asReadonly();

  readonly isAuthenticated = this._isAuthenticated.asReadonly();
  readonly user = this._user.asReadonly();

  updateUser(updateFn: (user: AuthUser) => AuthUser) {
    this._user.update(u => u ? updateFn(u) : null);
  }

  /** Set when the profile in `user` may belong to another session (a sign-in
   *  here or in another tab): the next fetch must not be skipped. */
  private profileStale = true;

  /** The deferred bootstrap profile fetch, until it runs. */
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the injector is destroyed; deferred work then does nothing. */
  private destroyed = false;

  constructor() {
    // Tie Sentry errors to the signed-in account by id only — never email or
    // name — so we can tell one user hitting a bug ten times from ten users.
    effect(() => {
      const id = this._user()?.id;
      sentry.setUser(id == null ? null : { id: String(id) });
    });

    // An older build kept the JWT pair in localStorage. The session is
    // cookie-borne now, so those copies are only a liability: drop them.
    if (typeof localStorage !== 'undefined') {
      try {
        for (const key of LEGACY_TOKEN_KEYS) localStorage.removeItem(key);
      } catch {
        // Storage blocked: nothing could have been stored there either.
      }
    }

    if (typeof document !== 'undefined') {
      if (hasSessionHint()) {
        this._isAuthenticated.set(true);
        // Bootstrap: fetch profile once when the page initialises with a
        // session cookie. Deferred via setTimeout to break the construction
        // cycle — AuthStore → HttpClient → HTTP_INTERCEPTORS → AuthInterceptor
        // → AuthStore. Waiting one microtask lets all providers finish.
        // Wrapped in runInInjectionContext: this fires as an independent
        // macrotask that can land in the same browser task turn as the
        // router's initial (possibly lazy-loaded) route resolution, and
        // without an explicit context the nested first-time DI resolution
        // inside fetchUserProfile() (HttpClient + interceptors) can race
        // Angular's internal "current injector" tracking and throw NG0203.
        this.bootstrapTimer = setTimeout(() => {
          this.bootstrapTimer = null;
          runInInjectionContext(this.injector, () => untracked(() => this.fetchUserProfile()));
        }, 0);
      }
    }

    if (typeof window !== 'undefined') {
      // Other tabs announce sign-ins and sign-outs (the cookies are shared,
      // but nothing tells this tab they changed). BroadcastChannel where it
      // exists; otherwise a localStorage ping, whose value is no secret.
      const onAuthEvent = (event: unknown) => {
        if (this.destroyed) return;
        if (event === 'logout') {
          // Route it through the same handling as an expiry in this tab, so it
          // clears the GA identity too and does not strand this tab on a page
          // it can no longer see. No re-broadcast: that would ping-pong.
          if (this._isAuthenticated()) this.endSession(false);
        } else if (event === 'login') {
          this._isAuthenticated.set(true);
          this.profileStale = true;
          untracked(() => this.fetchUserProfile());
        }
      };
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel(AUTH_CHANNEL);
        this.channel.onmessage = (e: MessageEvent) => onAuthEvent(e.data?.type);
      }
      const onStorage = (e: StorageEvent) => {
        if (this.channel || e.key !== AUTH_PING_KEY || !e.newValue) return;
        onAuthEvent(e.newValue.split(':')[0]);
      };
      window.addEventListener('storage', onStorage);

      // A profile that failed to load for a reason unrelated to the session
      // gets another chance whenever the visitor does something: moves to
      // another page, or comes back to the tab. See retryProfileIfMissing.
      const onVisible = () => {
        if (document.visibilityState === 'visible') {
          this.retryProfileIfMissing();
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      const navigations = this.router.events
        .pipe(filter(e => e instanceof NavigationEnd))
        .subscribe(() => this.retryProfileIfMissing());

      // Removed with the injector. A root service outlives nothing in the app,
      // but a destroyed store still listening would act on a dead injector
      // (NG0205) the next time another tab announces a sign-in or sign-out.
      inject(DestroyRef).onDestroy(() => {
        // The deferred bootstrap fetch and navigation re-check would
        // otherwise still run, and each reaches for this.injector or the
        // router: NG0205.
        this.destroyed = true;
        if (this.bootstrapTimer !== null) {
          clearTimeout(this.bootstrapTimer);
          this.bootstrapTimer = null;
        }
        window.removeEventListener('storage', onStorage);
        this.channel?.close();
        this.channel = null;
        document.removeEventListener('visibilitychange', onVisible);
        navigations.unsubscribe();
        this.cancelProfileRetry();
      });
    }
  }

  private channel: BroadcastChannel | null = null;

  /** Tell the other tabs of this browser. Best effort. */
  private announce(type: AuthEvent): void {
    try {
      if (this.channel) {
        this.channel.postMessage({ type });
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(AUTH_PING_KEY, `${type}:${Date.now()}`);
      }
    } catch {
      // A closed channel or blocked storage: the other tabs find out on their
      // next request instead.
    }
  }

  /**
   * 判斷目前網址是否在 /account 底下。
   */
  private isAccountUrl(): boolean {
    const checkPath = (u: string | null | undefined) => {
      if (!u) return false;
      const stripped = stripRegionPrefix(u).split(/[?#]/)[0].replace(/\/$/, '') || '/';
      return stripped === '/account' || stripped.startsWith('/account/');
    };
    if (this.router && checkPath(this.router.url)) return true;
    if (typeof window !== 'undefined' && checkPath(window.location?.pathname)) return true;
    return false;
  }

  /**
   * Best-effort profile fetch. Idempotent: once this session's profile is
   * loaded it is not fetched again until a sign-in marks it stale.
   */
  private fetchUserProfile(includeLists?: boolean): void {
    // No hint cookie, no session cookies: /auth/me/ could only say 401.
    if (!this._isAuthenticated() || !hasSessionHint()) return;
    const wantLists = includeLists ?? this.isAccountUrl();
    if (!this.profileStale && this._user() && (!wantLists || this.profileHasLists)) return;

    // One profile request per session at a time. The bootstrap fetch, the
    // first NavigationEnd and a sign-in's markSignedIn() can all ask within the
    // same moment; the request already out will fill in the user for all of
    // them (a 401 on it is refreshed and replayed by the interceptor).
    if (this.profileRequestGeneration === this._sessionGeneration) return;

    this.profileStale = false;

    const generation = this._sessionGeneration;
    this.profileRequestGeneration = generation;
    this.profileInFlightIncludesLists = wantLists;

    let params = new HttpParams();
    if (wantLists) {
      params = params.set('include', 'listings,subscriptions');
    }
    const request = this.http.get<AuthUser>('/auth/me', { params }).pipe(
      tap(profile => {
        // Signed out while this was in the air (e.g. logout with an expired
        // access token: the refresh fires this fetch, then the retried logout
        // lands first). Writing it would bring back the user it belonged to —
        // in the header, in the admin checks, and as GA's user id.
        if (generation !== this._sessionGeneration) {
          return;
        }
        this.cancelProfileRetry();
        this._user.set(profile);
        this._profileSettled.set(true);
        this.profileHasLists = wantLists;
        this.profileFetchedAt = Date.now();
        // A week-old push token is sent to the backend again (a no-op for an
        // account that never turned push on in this browser).
        void this.injector.get(PushService).refreshRegistration(profile.id);
        // Identify user in GA4 for User Explorer & cross-device reports
        this.ga.setUserId(profile.id);
        this.ga.setUserProperties({
          school: null,
          verified_region_count: profile.verifications ? profile.verifications.filter(v => !!v.verified_at).length : 0,
          role:        null   // enriched later if needed
        });
      }),
      catchError(err => {
        // Whatever the failure, no profile is coming from this request.
        if (generation === this._sessionGeneration) this._profileSettled.set(true);
        if (err.status === 401) {
          this.endSession();
        } else {
          console.error('Failed to load user profile from /auth/me', err?.status, err);
          // The session is intact but the profile is missing — which looks
          // exactly like being signed out: no name in the header, no admin
          // link. That used to last until a full reload. On a cold serverless
          // start the first /auth/me/ (and the refresh behind it) can fail
          // while a request seconds later succeeds, so try again on a timer.
          if (isTransientHttpFailure(err)) {
            this.scheduleProfileRetry();
          }
        }
        // Clear the dedup flag so a later sign-in or retry fetches again
        this.profileStale = true;
        return of(null);
      }),
      finalize(() => {
        if (this.profileRequestGeneration === generation) {
          this.profileRequestGeneration = null;
        }
        if (this.profileInFlight === request) {
          this.profileInFlight = null;
          this.profileInFlightIncludesLists = false;
        }
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.profileInFlight = request;
    request.subscribe();
  }

  /** The /auth/me/ request out now, shared; null once it has settled. */
  private profileInFlight: Observable<AuthUser | null> | null = null;
  /** Whether the profileInFlight request included listings and subscriptions. */
  private profileInFlightIncludesLists = false;
  /** Whether the current _user() includes listings and subscriptions. */
  private profileHasLists = false;
  /** When the current user was last fetched from /auth/me/. */
  private profileFetchedAt = 0;

  /**
   * The profile this store fetched, for AccountService to reuse rather than
   * ask for again: the /auth/me/ request already out, or the answer to one
   * that completed after `notBefore` and within `maxAgeMs`. Null when there
   * is neither — the caller fetches its own. The request out may still end
   * in null (a failure); callers treat that as "fetch your own" too.
   *
   * Both used to fetch /auth/me/ as a page started — this store without
   * parameters, AccountService with ?page=1, the same answer — so every
   * signed-in page that read the profile loaded it twice.
   */
  /**
   * Start this store's /auth/me/ request if none is out and none is needed
   * (see fetchUserProfile), so a caller that reached for the profile first —
   * the admin guard runs during the first navigation, before this store has
   * asked — can share that request instead of sending its own.
   */
  requestProfile(includeLists?: boolean): void {
    untracked(() => this.fetchUserProfile(includeLists));
  }

  sharedProfile(notBefore: number, maxAgeMs: number, requireLists = false): Observable<AuthUser | null> | null {
    if (this.profileInFlight) {
      if (!requireLists || this.profileInFlightIncludesLists) {
        return this.profileInFlight;
      }
    }
    const user = this._user();
    if (user && this.profileFetchedAt > notBefore && Date.now() - this.profileFetchedAt < maxAgeMs) {
      if (!requireLists || this.profileHasLists) {
        return of(user);
      }
    }
    return null;
  }

  /** The session generation a /auth/me/ request is out for, or null. */
  private profileRequestGeneration: number | null = null;
  private profileRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private profileRetryIndex = 0;

  /** After a transient failure. Short enough to catch a function warming up,
   *  spaced enough not to hammer a backend that is actually down. Once these
   *  run out, the next navigation or return to the tab tries again. */
  private static readonly PROFILE_RETRY_DELAYS_MS = [3000, 10000, 30000];

  /** Signed in, no profile, nothing already fetching it: fetch it. */
  private retryProfileIfMissing(): void {
    if (!this._isAuthenticated() || this._user()) return;
    untracked(() => this.fetchUserProfile());
  }

  private scheduleProfileRetry(): void {
    if (this.profileRetryTimer !== null) return;
    const delay = AuthStore.PROFILE_RETRY_DELAYS_MS[this.profileRetryIndex];
    if (delay === undefined) return;
    this.profileRetryIndex++;
    this.profileRetryTimer = setTimeout(() => {
      this.profileRetryTimer = null;
      // Same reason as the bootstrap fetch: an independent macrotask doing
      // first-time DI resolution needs an explicit injection context (NG0203).
      runInInjectionContext(this.injector, () => this.retryProfileIfMissing());
    }, delay);
  }

  private cancelProfileRetry(): void {
    if (this.profileRetryTimer !== null) {
      clearTimeout(this.profileRetryTimer);
      this.profileRetryTimer = null;
    }
    this.profileRetryIndex = 0;
  }

  /**
   * Set by a sign-in — a password, Google, a confirmed registration — and
   * taken by AccountService when the profile it brings arrives: that is when
   * the saved region and language are applied. A page load that restores a
   * session, or a token refresh, keeps the device's own.
   */
  private signInPending = false;

  /** Whether the profile now in `user` came with a sign-in; true once. */
  takeSignIn(): boolean {
    const pending = this.signInPending;
    this.signInPending = false;
    return pending;
  }

  /**
   * A sign-in succeeded: the server has set the session cookies. Nothing is
   * stored here — the tokens are HttpOnly and never reach this code.
   */
  markSignedIn(): void {
    this._isAuthenticated.set(true);
    this.profileStale = true;
    this.announce('login');
    // Fetch the profile immediately (not via an effect) so the UI can show
    // the user name without waiting for a second change-detection cycle.
    untracked(() => this.fetchUserProfile());
  }

  private router = inject(Router);
  // Resolved lazily via the injector below, never with a field-level
  // inject(). AuthStore is constructed by AuthInterceptor, and
  // RegionLinkService → RegionService → HttpClient → HTTP_INTERCEPTORS closes
  // a DI cycle: Angular then fails the entire interceptor chain with NG0200
  // and every API call in the app dies, which surfaces as a bare
  // "An error occurred" on each page. Its only use is inside a navigation
  // handler, long after the injector is built.
  private get regionLink(): RegionLinkService {
    return this.injector.get(RegionLinkService);
  }
  private injector = inject(Injector);
  private ga = inject(GoogleAnalyticsService);

  // Lazy HttpClient: avoids circular dependency with HTTP_INTERCEPTORS.
  // AuthInterceptor → AuthStore → HttpClient → HTTP_INTERCEPTORS → AuthInterceptor
  // would be a cycle if we injected HttpClient directly in the constructor;
  // resolving it lazily via Injector lets all interceptors finish initialising
  // before the first HTTP call actually needs HttpClient.
  private _http: HttpClient | null = null;
  private get http(): HttpClient {
    if (!this._http) {
      this._http = this.injector.get(HttpClient);
    }
    return this._http;
  }

  /**
   * Wipe every trace of the session. Deliberately does NOT navigate — see
   * endSession() for a session that ended on its own, and logout() for one
   * the visitor asked for.
   */
  private clearAuth() {
    clearSessionHint();
    this._sessionGeneration++;
    this.cancelProfileRetry();
    this._isAuthenticated.set(false);
    this._user.set(null);
    this._profileSettled.set(true);
    this.profileHasLists = false;
    this.profileInFlightIncludesLists = false;
    this.profileStale = true;
    this.signInPending = false;
    // Clear GA4 user identity on logout
    this.ga.setUserId(null);
    this.ga.clearUserProperties();
  }

  private _sessionGeneration = 0;

  /**
   * Changes, synchronously, every time a session ends. A response that was
   * requested under one generation and lands under another belongs to a
   * session that no longer exists, and must not be written anywhere shared —
   * see AccountService.getMyProfile(). Synchronous on purpose: an effect on
   * isAuthenticated() would run a scheduling step later, which is exactly the
   * window an in-flight response lands in.
   */
  get sessionGeneration(): number {
    return this._sessionGeneration;
  }

  /**
   * The session ended without the visitor asking for it: the access token
   * expired and the refresh was refused, or another tab signed out.
   * `announce` tells the other tabs; false when the news came from one.
   *
   * Clears the session, then moves the visitor only when they are somewhere a
   * signed-out visitor cannot be. Staying put is the whole point. This used
   * to navigate unconditionally, which threw people off the *public* homepage
   * the moment the background bootstrap GET /auth/me/ failed to refresh a
   * stale token — the page had rendered, and then the backend's answer yanked
   * them to /login for no reason they could see.
   *
   * Where "cannot be" is decided is signed-out-redirect.ts: each guard
   * registers the destination it would itself have chosen, so /account still
   * goes to /login (now carrying a returnUrl, which the old unconditional
   * navigate threw away) and /admin still goes home.
   */
  endSession(announce = true): void {
    const wasSignedIn = this._isAuthenticated();
    this.clearAuth();
    if (announce && wasSignedIn) this.announce('logout');
    // Several requests can fail together on one page load (the bootstrap
    // /auth/me/ and the message hub token, then the anonymous retry of
    // /auth/me/), so this can run several times in a row. That needs no
    // bookkeeping: the first decision that redirects starts a navigation, and
    // every later one waits for it and then finds the visitor already on a page
    // they may see.
    this.afterNavigationSettles(() => this.leaveIfUnwelcome());
  }

  /**
   * "Where is the visitor?" has no answer while a navigation is under way.
   * routerState only advances when a navigation commits, which is after
   * canActivate AND after the lazy chunk has downloaded — every guarded route
   * here is loadComponent. In that window routerState still describes the page
   * being left (or, on a cold deep link, nothing at all), so reading it then
   * gets both directions wrong: a deep link into /account that already passed
   * authGuard on the stale token would be left to activate signed-out, and a
   * visitor leaving /account for a public page would be pulled back to /login.
   *
   * So wait for the navigation to finish, and decide against where it landed.
   * The re-check runs a macrotask after the terminal event because the router
   * emits NavigationEnd before clearing currentNavigation, and a guard that
   * redirects starts its follow-up navigation in between.
   */
  private afterNavigationSettles(decide: () => void): void {
    if (!this.router.currentNavigation()) {
      decide();
      return;
    }
    this.router.events.pipe(
      filter(e =>
        e instanceof NavigationEnd ||
        e instanceof NavigationCancel ||
        e instanceof NavigationError ||
        e instanceof NavigationSkipped
      ),
      take(1)
    ).subscribe(() => setTimeout(() => {
      if (!this.destroyed) this.afterNavigationSettles(decide);
    }, 0));
  }

  private leaveIfUnwelcome(): void {
    // Signed back in while we waited for the navigation: nothing to leave.
    if (this.isAuthenticated()) {
      return;
    }

    const redirect = signedOutRedirectFor(this.router.routerState.snapshot.root);
    if (!redirect) {
      return;
    }

    const returnUrl = this.router.url;
    const target = runInInjectionContext(this.injector, () => redirect(returnUrl));
    // replaceUrl: Back would otherwise land on the page they just lost access
    // to, whose guard immediately bounces them out again.
    this.router.navigateByUrl(target, { replaceUrl: true });
  }

  isVerifiedIn(regionCode: string): boolean {
    return isUserVerifiedIn(this.user()?.verifications, regionCode);
  }

  isLoggedIn() {
    return this.isAuthenticated();
  }

  getUser() {
    return this.user();
  }

  /** `challenge`: a Turnstile token, when the server asked for one. */
  login(email: string, password: string, challenge?: string): Observable<any> {
    const body = challenge ? { email, password, cf_turnstile_response: challenge } : { email, password };
    return this.http.post<any>('/auth/login', body).pipe(
      tap(response => {
        if (isLoginSuccess(response)) {
          this.signInPending = true;
          this.markSignedIn();
          this.ga.trackLogin('Password');
        }
      })
    );
  }

  /**
   * The sign-in configuration (Google client id), fetched once per page and
   * shared. It does not change while the page is open, and three callers ask
   * for it as a sign-in page starts — One Tap, the form's effect and the
   * Google button — which sent /auth/config/ three times before the first
   * answer arrived. A failed request is dropped so the next caller retries.
   */
  private authConfig$: Observable<any> | null = null;

  getAuthConfig(): Observable<any> {
    if (!this.authConfig$) {
      this.authConfig$ = this.http.get<any>('/auth/config').pipe(
        catchError(err => {
          this.authConfig$ = null;
          return throwError(() => err);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.authConfig$;
  }

  loginWithGoogle(credential: string): Observable<any> {
    return this.http.post<any>('/auth/google', { credential }).pipe(
      tap(response => {
        if (isLoginSuccess(response)) {
          this.signInPending = true;
          this.markSignedIn();
          this.ga.trackLogin('Google');
        }
      })
    );
  }

  supportsPasskeys(): boolean {
    return typeof window !== 'undefined' && webauthnBrowser.browserSupportsWebAuthn();
  }

  cancelPasskey(): void {
    try {
      webauthnBrowser.WebAuthnAbortService.cancelCeremony();
    } catch {
      // ignore
    }
  }

  passkeyLogin(opts?: { useBrowserAutofill?: boolean }): Observable<any> {
    if (!this.supportsPasskeys()) {
      return throwError(() => new Error('WebAuthn not supported'));
    }
    return this.http
      .post<{ challenge_id: string; options: any }>('/auth/passkeys/login/options', {})
      .pipe(
        switchMap(async ({ challenge_id, options }) => {
          const response = await webauthnBrowser.startAuthentication({
            optionsJSON: options,
            ...(opts?.useBrowserAutofill ? { useBrowserAutofill: true } : {}),
          });
          return { challenge_id, response };
        }),
        switchMap(({ challenge_id, response }) =>
          this.http.post<any>('/auth/passkeys/login/verify', { challenge_id, response }),
        ),
        tap((response) => {
          if (isLoginSuccess(response)) {
            this.signInPending = true;
            this.markSignedIn();
            this.ga.trackLogin('Passkey');
          }
        }),
      );
  }

  passkeyRegister(name?: string): Observable<{ id: string; name: string }> {
    if (!this.supportsPasskeys()) {
      return throwError(() => new Error('WebAuthn not supported'));
    }
    return this.http
      .post<{ challenge_id: string; options: any }>('/auth/passkeys/register/options', {})
      .pipe(
        switchMap(async ({ challenge_id, options }) => {
          const response = await webauthnBrowser.startRegistration({ optionsJSON: options });
          return { challenge_id, response, name };
        }),
        switchMap(({ challenge_id, response, name }) =>
          this.http.post<{ id: string; name: string }>('/auth/passkeys/register/verify', {
            challenge_id,
            response,
            ...(name ? { name } : {}),
          }),
        ),
      );
  }

  listPasskeys(): Observable<PasskeyItem[]> {
    return this.http.get<PasskeyItem[]>('/auth/passkeys');
  }

  renamePasskey(id: string, name: string): Observable<{ id: string; name: string }> {
    return this.http.patch<{ id: string; name: string }>(`/auth/passkeys/${id}`, { name });
  }

  deletePasskey(id: string): Observable<void> {
    return this.http.delete<void>(`/auth/passkeys/${id}`);
  }

  /** `challenge`: a Turnstile token, when the server asked for one. */
  register(email: string, password: string, firstName: string, lastName: string, challenge?: string): Observable<any> {
    return this.http.post<any>('/auth/register', {
      email,
      password,
      first_name: firstName,
      last_name: lastName,
      ...(challenge ? { cf_turnstile_response: challenge } : {})
    }).pipe(
      tap(() => {
        this.ga.trackSignUp('Email');
      })
    );
  }

  requestEduVerification(eduEmail: string): Observable<any> {
    return this.http.post<any>('/auth/verify/request', { edu_email: eduEmail }).pipe(
      tap(() => {
        this.ga.trackEduVerificationRequest();
      })
    );
  }

  verifyEmail(token: string): Observable<any> {
    return this.http.post<any>('/auth/verify', { token });
  }

  // The password chosen at registration is asked for again: the server
  // activates only if it matches the one the link was issued for.
  verifyRegistration(token: string, password: string): Observable<any> {
    return this.http.post<any>('/auth/verify-registration', { token, password }).pipe(
      tap(response => {
        if (isLoginSuccess(response)) {
          this.signInPending = true;
          this.markSignedIn();
          this.ga.trackEvent('sign_up_verified');
        }
      })
    );
  }

  /** `challenge`: a Turnstile token, when the server asked for one. */
  requestPasswordReset(email: string, challenge?: string): Observable<any> {
    return this.http.post<any>('/auth/password/reset/request', challenge ? { email, cf_turnstile_response: challenge } : { email });
  }

  confirmPasswordReset(token: string, newPassword: string): Observable<any> {
    return this.http.post<any>('/auth/password/reset/confirm', { token, new_password: newPassword });
  }

  logout(): Observable<any> {
    // Before the session goes: the device removal still needs the session,
    // and a signed-out browser should stop receiving this account's messages.
    void this.injector.get(PushService).unregisterThisDevice();
    // No hint cookie: the server already ended the session (an account
    // deletion clears the cookies) or there never was one — nothing to revoke.
    if (hasSessionHint()) {
      // The refresh cookie travels with this request (Path=/api/v1/auth/);
      // the server revokes it and clears every session cookie.
      return this.http.post('/auth/logout', {}).pipe(
        tap({
          next: () => this.signOut(),
          error: () => this.signOut()
        }),
        catchError(() => of(null))
      );
    }
    this.signOut();
    return of(null);
  }

  /** Signing out is a deliberate act, so it always lands on the sign-in page —
   *  the same place the old /account login wall put them — whether or not the
   *  page they were on was one they could have stayed on. */
  private signOut(): void {
    this.clearAuth();
    this.announce('logout');
    this.router.navigate(this.regionLink.path(['/login']));
  }
}