import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, timer } from 'rxjs';
import { retry, catchError } from 'rxjs/operators';
import { isPlatformBrowser } from '@angular/common';
import { environment } from '../../environments/environment';

/**
 * RetryInterceptor — lightweight, targeted retry for transient server errors.
 *
 * Design decisions:
 * - Only intercepts requests to our own backend API (/api/v1). Absolute URLs
 *   (chat under /api/chat, Google sign-in) are left untouched.
 * - Retries ONLY on transient errors: HTTP 5xx (server fault, likely cold
 *   start timeout from Vercel Lambda), or status 0
 *   (browser network-level DNS/TCP failure — very common after idle).
 * - Does NOT retry 4xx: 401 is already handled by AuthInterceptor (session
 *   refresh flow), and 400/403/404 are permanent.
 * - Retries use an immediate first attempt + a single delayed retry (1s).
 *   This gives the Lambda instance time to warm up without adding
 *   meaningful user-perceived latency for the common case.
 */
@Injectable()
export class RetryInterceptor implements HttpInterceptor {
  private readonly maxRetries = 2; // total attempts = 1 initial + 2 retries
  private readonly baseDelayMs = 1000;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {}

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Only apply retries to our own backend API requests:
    // - Relative URLs (e.g. /listings/) haven't been prefixed by ApiUrlInterceptor yet
    // - URLs matching backendUrl have already been prefixed
    // Absolute URLs (chat's /api/chat, Google API) pass through without retry.
    const isOwnBackendRequest =
      !request.url.startsWith('http') ||
      request.url.startsWith(environment.backendUrl);

    // Reads only. A 5xx or a dropped connection says the response was lost,
    // not that the request was: on a cold Lambda the backend often finishes
    // the work and the gateway times out (504) or the socket closes anyway.
    // Replaying a POST, PATCH or DELETE then does it a second or third time —
    // a second order, a duplicate listing, a report sent twice. Those surface
    // their error to the caller, which can offer to try again.
    const isSafeToRepeat = request.method === 'GET' || request.method === 'HEAD';

    if (isOwnBackendRequest && isSafeToRepeat) {
      // The initial attempt and the retry are within the `retry` pattern, so
      // they share the same chain through the interceptor.
      return next.handle(request).pipe(
        retry({
          count: this.maxRetries,
          delay: (error, attempt) => {
            if (!this.shouldRetry(error)) {
              return throwError(() => error);
            }
            if (attempt > this.maxRetries) {
              return throwError(() => error);
            }
            const delayTime = this.baseDelayMs * attempt;
            if (isPlatformBrowser(this.platformId)) {
              console.warn(
                `[retry] ${request.method} ${request.url} failed (attempt ${attempt}) — retrying in ${delayTime}ms`
              );
            }
            return timer(delayTime);
          },
        }),
        catchError(error => {
          // After all retries exhausted, rethrow for the caller to handle
          // (e.g. show error state)
          if (error instanceof HttpErrorResponse && isPlatformBrowser(this.platformId)) {
            console.warn(
              `[retry] ${request.method} ${request.url} failed after ${this.maxRetries + 1} attempts — giving up`
            );
          }
          return throwError(() => error);
        })
      );
    }

    // Absolute URLs (chat, Google) and non-idempotent writes — no retry
    return next.handle(request);
  }

  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse)) {
      return false;
    }
    // A failed session refresh surfacing through AuthInterceptor has already
    // been retried there, on its own schedule. Retrying the outer request
    // re-runs that whole refresh schedule each time — three refresh POSTs
    // became nine for a single request while the token store was down.
    // error.url is the response's URL, which the browser reports absolute.
    if (error.url?.includes(`${environment.backendUrl}/auth/refresh`)) {
      return false;
    }
    // Server errors (502/503/504): the classic Lambda cold-start signature
    const is5xx = error.status >= 500 && error.status < 600;
    if (is5xx) {
      return true;
    }
    // 429 is not retried here: the backend asked us to slow down, and
    // RequestGuardInterceptor holds the endpoint off until its Retry-After.
    // status 0: CORS failure, network timeout, or the server forcibly closed
    // the connection before responding — common from overloaded Lambda
    return error.status === 0;
  }
}