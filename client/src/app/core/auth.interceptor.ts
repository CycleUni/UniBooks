import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpErrorResponse,
  HttpContextToken,
} from '@angular/common/http';

/** Set on public endpoints (anonymous-friendly views) so a 401 on them is
 * passed straight through instead of triggering a session refresh. The
 * session cookie still travels with them — the browser attaches it to every
 * same-origin request — and the server treats a stale one as anonymous. */
export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);
import { Observable, of, throwError } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { isPlatformBrowser } from '@angular/common';
import { AuthStore, hasAccessHint, hasSessionHint } from './auth.store';
import { SessionRefreshService } from './session-refresh.service';
import { environment } from '../../environments/environment';

/**
 * The session lives in HttpOnly cookies the server sets (server/src/lib/session.ts):
 * this interceptor never sees a token and never attaches one. Its one job is
 * the expired access cookie — on a 401 from the API it asks /auth/refresh/
 * (which reads the refresh cookie and sets a fresh pair) once, shared by every
 * request that failed meanwhile, and replays the original request.
 *
 * It also refreshes *before* a request when the readable `ub_access` hint has
 * lapsed (the access cookie is gone or about to be): otherwise a returning
 * visitor's first page sends every call twice, once for a 401 and once again.
 */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(
    private authStore: AuthStore,
    private sessionRefresh: SessionRefreshService,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {}

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

    // Signed in but the access cookie has lapsed: refresh first (shared with
    // every other request doing the same). A refresh that fails leaves the
    // request to the 401 path below, which owns the sign-out.
    const send$ = shouldHandle401 && hasSessionHint() && !hasAccessHint()
      ? this.sessionRefresh.refresh().pipe(catchError(() => of(null)), switchMap(() => next.handle(request)))
      : next.handle(request);

    return send$.pipe(
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
      url.includes('/auth/login') ||
      url.includes('/auth/google') ||
      url.includes('/auth/register') ||
      url.includes('/auth/verify-registration') ||
      url.includes('/auth/refresh')
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
    return this.sessionRefresh.refresh().pipe(switchMap(() => next.handle(request)));
  }

}
