import { Injectable, inject } from '@angular/core';
import { HttpBackend, HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, of, throwError, timer } from 'rxjs';
import { catchError, finalize, map, retry, shareReplay } from 'rxjs/operators';
import { AuthStore, hasAccessHint, hasSessionHint } from './auth.store';
import { environment } from '../../environments/environment';

/**
 * The one POST /auth/refresh a tab has in flight (it reads the refresh cookie
 * and sets a fresh pair). Shared by AuthInterceptor — on a 401, or before a
 * request once the access hint has lapsed — and by the chat hub, whose
 * WebSocket signs in with the access cookie and so needs a live one first.
 */
@Injectable({ providedIn: 'root' })
export class SessionRefreshService {
  private authStore = inject(AuthStore);
  // HttpBackend skips the interceptor chain: AuthInterceptor depends on this
  // service, so going through HttpClient's interceptors would be circular.
  private http = new HttpClient(inject(HttpBackend));
  private readonly url = `${environment.backendUrl}/auth/refresh`;

  // In-flight refresh request; everyone asking meanwhile shares it so the
  // one-time-use refresh cookie is not sent to /auth/refresh twice.
  private inProgress$: Observable<unknown> | null = null;

  /** Both well inside the backend's refresh rotation grace window. */
  static readonly RETRY_DELAYS_MS = [1000, 2000];

  /**
   * A live access cookie: at once when the access hint is there, else after a
   * refresh. Fails with a 401 when there is no session at all, and with the
   * refresh's own error when that fails.
   */
  ensureAccess(): Observable<void> {
    if (!hasSessionHint()) return throwError(() => new HttpErrorResponse({ status: 401, url: this.url }));
    if (hasAccessHint()) return of(undefined);
    return this.refresh().pipe(map(() => undefined));
  }

  refresh(): Observable<unknown> {
    if (!this.inProgress$) {
      this.inProgress$ = this.http.post(this.url, null).pipe(
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
          count: SessionRefreshService.RETRY_DELAYS_MS.length,
          delay: (err, attempt) =>
            SessionRefreshService.isTransient(err)
              ? timer(SessionRefreshService.RETRY_DELAYS_MS[attempt - 1])
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
          this.inProgress$ = null;
        }),
        // refCount: false — with refCount:true, the last subscriber going away
        // (a component torn down by navigation, say) unsubscribes the shared
        // source and ABORTS the in-flight POST /auth/refresh. The server may
        // already have rotated the token by then, so the browser never stores
        // the new cookies and the next refresh replays a dead one. Letting the
        // request run to completion costs nothing: finalize still clears the
        // field when it settles.
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.inProgress$;
  }

  private static isTransient(err: unknown): boolean {
    return err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 500);
  }
}
