import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpParams, HttpContext } from '@angular/common/http';
import { Observable, of, shareReplay, switchMap, take, tap, catchError, throwError } from 'rxjs';
import { Router } from '@angular/router';
import { I18nService } from '../i18n.service';
import { Lang, SUPPORTED_LANGS } from '../i18n';
import { AuthStore, AuthUser, PasskeyItem, UserRole } from '../auth.store';
import { RegionService } from '../region.service';
import { SKIP_AUTH } from '../auth.interceptor';
import { isSameRegion, stripRegionPrefix } from '../region-path';
export interface ChatReportItem {
  id: string;
  conversation?: {
    id: string;
    listing_title?: string;
  };
  reporter?: {
    id: string;
    email: string;
  };
  reported_party?: {
    id: string;
    email: string;
  };
  reason: string;
  detail?: string;
  flagged_message_ids?: string[];
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
}

export interface ListingReportItem {
  id: string;
  listing?: {
    id: string;
    title?: string;
    deleted?: boolean;
  };
  reporter?: {
    id: string;
    email: string;
  };
  reason: string;
  detail?: string;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
}

export interface PaginatedResponse<T> {
  count: number;
  results: T[];
}

export interface SchoolRequestInput {
  school_name: string;
  school_website: string;
  /** What the user had typed into the campus-email field, if anything. */
  edu_email?: string;
}

export interface SchoolRequest extends SchoolRequestInput {
  id: number;
  status: 'pending' | 'added' | 'rejected';
  created_at: string;
}

/** 'auto' follows the language the site was last used in. */
export type EmailLanguage = 'auto' | Lang;

/** The account page's Notifications section. */
export interface NotificationSettings {
  /** Email about a chat message that arrives while not on the site. */
  new_message_email: boolean;
  /** Push notifications of every kind, to each browser the member enabled them in. */
  push: boolean;
  /** The one language notification emails are written in. */
  email_language: EmailLanguage;
  /** Read-only: the site language 'auto' currently resolves to. */
  site_language: string;
}

export interface UserProfile {
  id: string | number;
  email: string;
  edu_email?: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  school?: string | number | null;
  school_name?: string;
  is_active?: boolean;
  verified_at?: string | null;
  average_rating?: number;
  review_count?: number;
  no_show_count?: number;
  has_password?: boolean;
  avatar_url?: string;
  /** Whether other users see avatar_url; the owner always gets it. */
  show_avatar?: boolean;
  is_google_linked?: boolean;
  role?: UserRole;
  last_seen_bought_orders_at?: string | null;
  last_seen_sold_orders_at?: string | null;
  [key: string]: unknown;
}

/**
 * AccountService — thin wrapper over /auth/me/ and related endpoints.
 *
 * The canonical "logged-in user" state is now owned by AuthStore.user
 * (auto-fetched on every login and on bootstrap when a persisted token
 * exists). This service still exposes getMyProfile() for components that
 * need the latest profile at a specific moment, but its cache acts only as
 * a short-lived deduplication layer, not the primary source of truth.
 */
@Injectable({
  providedIn: 'root'
})
export class AccountService {
  private http = inject(HttpClient);

  // Lightweight dedup cache: holds the last successful /auth/me/ response
  // for the current login session so multiple concurrent consumers don't
  // each fire separate requests. Cleared on language switch.
  readonly profileCache = signal<UserProfile | null>(null);
  private profileLoading = signal(false);
  private profileRequest: Observable<UserProfile> | null = null;
  private cacheTimestamp = 0;
  private static readonly PROFILE_CACHE_TTL = 60_000; // 60 秒
  private i18n = inject(I18nService);

  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);
  private router = inject(Router);

  constructor() {
    // The cached profile carries localized fields (school_name and the like),
    // so the language switching has to drop it, or the pages that reload on
    // the switch are served the old language from it.
    let langSeen = false;
    effect(() => {
      this.i18n.lang();
      if (!langSeen) { langSeen = true; return; }
      untracked(() => this.clearProfileCache());
    });

    // The AuthStore now manages the lifecycle of /auth/me/ — it fetches on
    // bootstrap (if a token exists) and on every login. That value flows
    // into AuthStore.user. This service's cache merely mirrors it for
    // compatibility with existing components that read profileCache().
    // We keep this function as a convenience; calling getMyProfile() when
    // AuthStore.user already has data will return the cached copy.

    // Drop the cache when the session ends. It is keyed to nothing but "the
    // current login", and adminGuard/superuserGuard read profileCache()
    // directly with no TTL check (the 60s TTL lives inside getMyProfile only) —
    // so a cache surviving into the next sign-in would judge a different user
    // on the previous one's role. This clears what is
    // already cached; a response still in flight at sign-out is dropped by the
    // session-generation check in getMyProfile(), which this effect alone
    // could not catch.
    effect(() => {
      if (!this.authStore.isAuthenticated()) {
        this.clearProfileCache();
      }
    });

    // The region and language follow the member between devices. A sign-in
    // brings back the ones saved last (applySavedPrefs); otherwise each is
    // reported whenever it differs from what the profile says, so a page
    // load in unchanged settings sends nothing. The language is also what
    // the notification emails sent while the member is away (a chat message,
    // a book request listed overnight) are written in.
    effect(() => {
      const user = this.authStore.user();
      const lang = this.i18n.lang();
      const region = this.regionService.region();
      if (!user) return;
      untracked(() => {
        if (this.authStore.takeSignIn() && this.applySavedPrefs(user)) return;
        if (this.applyingSavedPrefs) return;
        this.reportLanguage(user, lang);
        this.reportRegion(user, region);
      });
    });
  }

  private siteLanguageReported: string | null = null;
  private siteRegionReported: string | null = null;
  /** While a sign-in's saved settings are being applied: reporting the
   *  device's own in the meantime would overwrite them. */
  private applyingSavedPrefs = false;

  /**
   * Switches to the language and region saved on the account, on signing in.
   * The language when the region in view offers it; the region only when the
   * sign-in is heading to the account or home page — a link to a page in
   * another region keeps that page. True when something is being applied.
   */
  private applySavedPrefs(user: AuthUser): boolean {
    const current = this.regionService.region();
    const savedRegion = (user.site_region ?? '').toLowerCase();
    const switchRegion = !!savedRegion && savedRegion !== current && this.signInLandsOnAccount();
    const regionCode = switchRegion ? savedRegion : current;
    const offered = this.regionService.regions().find(r => r.code.toLowerCase() === regionCode)?.languages;
    const savedLang = user.site_language as Lang;
    const switchLang = SUPPORTED_LANGS.includes(savedLang)
      && savedLang !== this.i18n.lang()
      && (!offered || offered.includes(savedLang));
    if (!switchLang && !switchRegion) return false;

    this.applyingSavedPrefs = true;
    (async () => {
      try {
        if (switchLang) {
          // A language the member chose: the device-language offer would
          // only suggest switching straight back.
          this.i18n.settleSuggestion();
          await this.i18n.setLang(savedLang);
        }
        // Reloads into the region (RegionService.setRegion).
        if (switchRegion) this.regionService.setRegion(savedRegion);
      } finally {
        this.applyingSavedPrefs = false;
      }
    })();
    return true;
  }

  /** Whether the sign-in ends on the account page or home: where it is now,
   *  or, still on the sign-in page, where its returnUrl leads. */
  private signInLandsOnAccount(): boolean {
    const pathOf = (url: string) =>
      stripRegionPrefix(url).split(/[?#]/)[0].replace(/\/$/, '') || '/';
    let path = pathOf(this.router.url);
    if (path === '/login' || path === '/register') {
      const returnUrl = this.router.parseUrl(this.router.url).queryParams['returnUrl'];
      if (!returnUrl) return true;
      path = pathOf(String(returnUrl));
    }
    return path === '/' || path === '/account' || path.startsWith('/account/');
  }

  private reportLanguage(user: AuthUser, lang: Lang) {
    if (user.site_language === lang) return;
    const reporting = `${user.id}:${lang}`;
    if (this.siteLanguageReported === reporting) return;
    this.siteLanguageReported = reporting;
    this.http.put('/auth/me/site-language', { language: lang }).subscribe({
      next: () => this.authStore.updateUser(u => ({ ...u, site_language: lang })),
      // Best effort; the next page load or language change tries again.
      error: () => {
        if (this.siteLanguageReported === reporting) this.siteLanguageReported = null;
      },
    });
  }

  /** Only a region the member has verified a school email in is saved:
   *  where they trade, not wherever they happen to be browsing. */
  private reportRegion(user: AuthUser, region: string) {
    const code = region.toUpperCase();
    if (!user.regions?.includes(code) || user.site_region === code) return;
    const reporting = `${user.id}:${code}`;
    if (this.siteRegionReported === reporting) return;
    this.siteRegionReported = reporting;
    this.http.put('/auth/me/site-region', { region: code }).subscribe({
      next: () => this.authStore.updateUser(u => ({ ...u, site_region: code })),
      error: () => {
        if (this.siteRegionReported === reporting) this.siteRegionReported = null;
      },
    });
  }


  /**
   * `opts` narrows and orders the caller's own listings (the account's
   * listings page). Only the plain call — first page, no search, no filter —
   * is cached and de-duplicated: that is the one every part of the app makes
   * for the profile itself.
   */
  getMyProfile(page: number = 1, q: string = '', opts: { status?: string; sort?: string } = {}): Observable<any> {
    // For backwards-compat callers that still use this directly,
    // leave the existing logic intact but always call /auth/me/
    const plain = page === 1 && !q && !opts.status && !opts.sort;
    const cached = this.profileCache();
    const cacheValid = cached
      && plain
      && (Date.now() - this.cacheTimestamp) < AccountService.PROFILE_CACHE_TTL;
    if (cacheValid) {
      return new Observable(subscriber => {
        subscriber.next(cached);
        subscriber.complete();
      });
    }

    if (this.profileLoading() && this.profileRequest && plain) {
      return this.profileRequest;
    }

    // The plain profile is also what AuthStore fetches as the session
    // starts; join that request, or take its fresh answer, instead of
    // sending /auth/me/ a second time. Only an answer newer than the last
    // clearProfileCache() counts, so a page that just changed something and
    // cleared the cache still gets a fresh read. A shared request that
    // failed (null) falls back to this service's own fetch.
    if (plain) {
      let shared = this.authStore.sharedProfile(this.clearedAt, AccountService.PROFILE_CACHE_TTL, true);
      if (!shared && this.authStore.isAuthenticated()) {
        // Nothing to share yet: have AuthStore send the one request both need.
        this.authStore.requestProfile(true);
        shared = this.authStore.sharedProfile(this.clearedAt, AccountService.PROFILE_CACHE_TTL, true);
      }
      if (shared) {
        return shared.pipe(
          take(1),
          switchMap(profile => profile ? of(profile) : this.fetchOwnProfile()),
          tap(profile => {
            if (!this.profileCache()) {
              this.profileCache.set(profile);
              this.cacheTimestamp = Date.now();
            }
          }),
        );
      }
    }
    return this.fetchOwnProfile(page, q, opts);
  }

  /** When clearProfileCache() last ran; see getMyProfile. */
  private clearedAt = 0;

  private fetchOwnProfile(page: number = 1, q: string = '', opts: { status?: string; sort?: string } = {}): Observable<any> {
    const plain = page === 1 && !q && !opts.status && !opts.sort;

    if (plain) this.profileLoading.set(true);
    let params = new HttpParams().set('page', page.toString()).set('include', 'listings,subscriptions');
    if (q) params = params.set('q', q);
    if (opts.status) params = params.set('status', opts.status);
    if (opts.sort) params = params.set('sort', opts.sort);
    // Two separate questions when a response lands, answered separately:
    //  - May it fill the cache? Only if the session that asked for it still
    //    exists. Otherwise it re-fills the cache a sign-out just cleared.
    //  - May it release the flight-lock? Only if the lock is still its own.
    //    A newer request may hold it by now, and must not be clobbered; but a
    //    request whose session ended while it was out must still let go, or
    //    every later call replays it forever. That is not hypothetical: a
    //    request that 401s while signed out ends the session itself (the
    //    interceptor has no refresh token to try), which moves the generation
    //    with no signed-in -> signed-out change for the effect above to see.
    const generation = this.authStore.sessionGeneration;
    const stillCurrent = () => generation === this.authStore.sessionGeneration;
    const ownsLock = () => this.profileRequest === req;
    const req: Observable<any> = this.http.get<any>('/auth/me', { params }).pipe(
      tap(profile => {
        if (!plain) return;
        if (stillCurrent()) {
          this.profileCache.set(profile);
          this.cacheTimestamp = Date.now();
        }
        if (ownsLock()) {
          this.profileLoading.set(false);
          this.profileRequest = null;
        }
      }),
      catchError(err => {
        // Reset flight-lock and cache on error so the next call retries
        // instead of re-subscribing to the same failed Observable forever.
        if (plain && ownsLock()) {
          this.profileLoading.set(false);
          this.profileRequest = null;
          this.cacheTimestamp = 0;
        }
        return throwError(() => err);
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    if (plain) this.profileRequest = req;
    return req;
  }

  getNotificationSettings(): Observable<NotificationSettings> {
    return this.http.get<NotificationSettings>('/auth/me/notifications');
  }

  updateNotificationSettings(changes: Partial<NotificationSettings>): Observable<NotificationSettings> {
    return this.http.patch<NotificationSettings>('/auth/me/notifications', changes);
  }

  clearProfileCache() {
    this.clearedAt = Date.now();
    this.profileCache.set(null);
    this.profileLoading.set(false);
    this.profileRequest = null;
    this.cacheTimestamp = 0;
  }

  updateProfile(data: { first_name?: string, last_name?: string, email?: string, current_password?: string, show_avatar?: boolean, last_seen_bought_orders_at?: string, last_seen_sold_orders_at?: string }): Observable<any> {
    return this.http.patch<any>('/auth/me', data).pipe(
      tap(profile => {
        // A request to change the sign-in email answers with the pending
        // address instead of the profile, since nothing has changed yet —
        // caching that as the profile would blank the account out.
        if (!profile || profile.id === undefined) return;
        // PATCH answers with the bare user, without the myListings,
        // myListingCounts and mySubscriptions a GET carries. Replacing the
        // cache with it left the account page reading zero listings and
        // requests for the next minute — which the orders tab, marking its
        // orders seen on every visit, did every time it opened.
        const cached = this.profileCache();
        if (!cached) return;
        this.profileCache.set({ ...cached, ...profile });
      })
    );
  }

  /** Apply a pending sign-in-email change. The token comes from the link in
   *  the mail sent to the new address; no session is needed to follow it. */
  confirmEmailChange(token: string): Observable<any> {
    return this.http.post<any>('/auth/email/change/confirm', { token });
  }

  cancelEmailChange(): Observable<any> {
    return this.http.post<any>('/auth/email/change/cancel', {});
  }

  /** Changing the password ends every other session; the response sets this
   *  browser's fresh session cookies, replacing the revoked ones, so there is
   *  nothing to store here. */
  changePassword(data: { old_password?: string, new_password?: string }): Observable<any> {
    return this.http.post<any>('/auth/password', data);
  }

  removePassword(data: { password?: string }): Observable<any> {
    return this.http.post<any>('/auth/password/remove', data);
  }

  requestEduVerification(eduEmail: string): Observable<any> {
    return this.http.post<any>('/auth/verify/request', { edu_email: eduEmail });
  }

  autoVerifyEduEmail(): Observable<any> {
    return this.http.post<any>('/auth/verify/auto', {}).pipe(
      tap(() => this.profileCache.set(null))
    );
  }

  /** "My school isn't supported": files a request for staff to add it.
   *  Resolves with 201 for a new request, 200 when an identical one is
   *  already pending — both mean the report is on file. */
  createSchoolRequest(data: SchoolRequestInput): Observable<SchoolRequest> {
    return this.http.post<SchoolRequest>('/auth/school-requests', data);
  }

  getPublicUserProfile(userId: string): Observable<any> {
    return this.http.get<any>(`/auth/users/${userId}`, {
      context: new HttpContext().set(SKIP_AUTH, true)
    });
  }

  unbindEduEmail(regionCode: string): Observable<any> {
    return this.http.post<any>('/auth/verify/unbind', { region: regionCode }).pipe(
      tap(() => {
        this.profileCache.update(p => p ? { ...p, verifications: (p['verifications'] as any[] || []).filter((v: any) => !isSameRegion(v.region, regionCode)) } : null);
        this.authStore.updateUser(u => ({ ...u, verifications: (u.verifications || []).filter((v: any) => !isSameRegion(v.region, regionCode)) }));
      })
    );
  }

  unsubscribe(subscriptionId: string): Observable<any> {
    return this.http.delete(`/subscriptions/${subscriptionId}`);
  }

  unsubscribeAll(): Observable<any> {
    return this.http.delete('/subscriptions');
  }

  getMySubscriptions(): Observable<any[]> {
    return this.http.get<any[]>('/subscriptions');
  }

  getMyListingReports(page: number = 1): Observable<PaginatedResponse<ListingReportItem>> {
    const params = new HttpParams().set('page', page.toString());
    return this.http.get<PaginatedResponse<ListingReportItem>>('/moderation/mine', { params });
  }

  getMyChatReports(page: number = 1): Observable<PaginatedResponse<ChatReportItem>> {
    const params = new HttpParams().set('page', page.toString());
    return this.http.get<PaginatedResponse<ChatReportItem>>('/moderation/chat-reports/mine', { params });
  }

  deleteAccount(): Observable<any> {
    return this.http.delete<any>('/auth/me');
  }

  listPasskeys(): Observable<PasskeyItem[]> {
    return this.authStore.listPasskeys();
  }

  renamePasskey(id: string, name: string): Observable<{ id: string; name: string }> {
    return this.authStore.renamePasskey(id, name);
  }

  deletePasskey(id: string): Observable<void> {
    return this.authStore.deletePasskey(id);
  }

  passkeyRegister(name?: string): Observable<{ id: string; name: string }> {
    return this.authStore.passkeyRegister(name);
  }

  passkeyLogin(): Observable<any> {
    return this.authStore.passkeyLogin();
  }
}