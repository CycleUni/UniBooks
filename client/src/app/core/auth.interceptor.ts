import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpErrorResponse,
  HttpBackend,
  HttpClient,
  HttpContextToken,
} from '@angular/common/http';

/** Set on public endpoints (anonymous-friendly views) so a 401 on them is
 * passed straight through instead of triggering a session refresh. The
 * session cookie still travels with them — the browser attaches it to every
 * same-origin request — and the server treats a stale one as anonymous. */
export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);
import { Observable, throwError, timer } from 'rxjs';
import { catchError, switchMap, finalize, shareReplay, retry } from 'rxjs/operators';
import { isPlatformBrowser } from '@angular/common';
import { AuthStore, hasSessionHint } from './auth.store';
import { environment } from '../../environments/environment';

/**
 * The session lives in HttpOnly cookies the server sets (server/src/lib/session.ts):
 * this interceptor never sees a token and never attaches one. Its one job is
 * the expired access cookie — on a 401 from the API it asks /auth/refresh/
 * (which reads the refresh cookie and sets a fresh pair) once, shared by every
 * request that failed meanwhile, and replays the original request.
 */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  // In-flight refresh request; concurrent 401s within this tab share it so the
  // one-time-use refresh cookie is not sent to /auth/refresh/ twice.
  private refreshInProgress$: Observable<unknown> | null = null;

  // Use HttpBackend directly for the refresh so we don't create a circular
  // dependency: AuthInterceptor → HttpClient → HTTP_INTERCEPTORS → AuthInterceptor.
  // HttpBackend is the raw XHR/fetch layer; it skips the entire interceptor chain.
  private http: HttpClient;

  private readonly refreshBackendUrl = `${environment.backendUrl}/auth/refresh/`;

  constructor(
    private authStore: AuthStore,
    backend: HttpBackend,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {
    this.http = new HttpClient(backend);
  }

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Chat (/api/chat) carries its own room- or hub-scoped bearer token set by
    // the caller; a 401 there is about that token, not the session.
    if (!request.url.startsWith(environment.backendUrl)) {
      return next.handle(request);
    }

    const shouldHandle401 =
      !this.isAuthEndpoint(request.url) &&
      !request.context.get(SKIP_AUTH) &&
      isPlatformBrowser(this.platformId);

    return next.handle(request).pipe(
      catchError((error) => {
        if (error instanceof HttpErrorResponse && error.status === 401 && shouldHandle401) {
          return this.refreshAndRetry(request, next, error);
        }
        return throwError(() => error);
      }),
    );
  }

  /** Endpoints whose 401 means "wrong credentials", not "session expired". */
  private isAuthEndpoint(url: string): boolean {
    return (
      url.includes('/auth/token/') ||
      url.includes('/auth/google/') ||
      url.includes('/auth/register/') ||
      url.includes('/auth/verify-registration/') ||
      url.includes('/auth/refresh/')
    );
  }

  private refreshAndRetry(
    request: HttpRequest<any>,
    next: HttpHandler,
    original: HttpErrorResponse,
  ): Observable<HttpEvent<any>> {
    // No hint cookie means no refresh cookie either (they share a lifetime and
    // are cleared together): asking would only earn a second 401.
    if (!hasSessionHint()) {
      if (this.authStore.isAuthenticated()) this.authStore.endSession();
      return throwError(() => original);
    }
    // Replayed once: a 401 on the retry is the answer, not another refresh.
    return this.refreshSession().pipe(switchMap(() => next.handle(request)));
  }

  private refreshSession(): Observable<unknown> {
    if (!this.refreshInProgress$) {
      this.refreshInProgress$ = this.http.post(this.refreshBackendUrl, null).pipe(
        // A refresh that fails for a reason unrelated to the session is retried
        // straight away, not left for "a later request". Two cases matter:
        //  - status 0 / 502 / 504: the response was lost, often after the
        //    server had already rotated the token. The rotated pair is handed
        //    back for the same refresh token only inside the backend's grace
        //    window, so waiting for the visitor's next click would usually
        //    miss it and turn a network blip into a sign-out.
        //  - 503: the backend could not reach its token store, and says so
        //    instead of pretending the token is unknown.
        retry({
          count: AuthInterceptor.REFRESH_RETRY_DELAYS_MS.length,
          delay: (err, attempt) =>
            AuthInterceptor.isTransient(err)
              ? timer(AuthInterceptor.REFRESH_RETRY_DELAYS_MS[attempt - 1])
              : throwError(() => err),
        }),
        catchError((err) => {
          if (err instanceof HttpErrorResponse && (err.status === 401 || err.status === 403)) {
            // The session is gone (the server cleared the cookies with this
            // answer): sign out here and send the visitor where the page's
            // guard would.
            this.authStore.endSession();
          }
          // Transient failures keep the session so a later request can try again.
          return throwError(() => err);
        }),
        finalize(() => {
          this.refreshInProgress$ = null;
        }),
        // refCount: false — with refCount:true, the last subscriber going away
        // (a component torn down by navigation, say) unsubscribes the shared
        // source and ABORTS the in-flight POST /auth/refresh/. The server may
        // already have rotated the token by then, so the browser never stores
        // the new cookies and the next refresh replays a dead one. Letting the
        // request run to completion costs nothing: finalize still clears the
        // field when it settles.
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.refreshInProgress$;
  }

  /** Both well inside the backend's refresh rotation grace window. */
  private static readonly REFRESH_RETRY_DELAYS_MS = [1000, 2000];

  private static isTransient(err: unknown): boolean {
    return err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 500);
  }
}
