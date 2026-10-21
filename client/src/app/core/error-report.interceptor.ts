import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { sentry } from './sentry';
import { environment } from '../../environments/environment';

/**
 * Reports server errors from our own backend to Sentry.
 *
 * Components catch these and show a toast, so they never reach Angular's
 * ErrorHandler; without this a 500 the user saw is invisible to us.
 *
 * Sits outside RetryInterceptor, so a GET is reported once, after its retries
 * are used up, not once per attempt.
 *
 * Only 5xx is reported. 4xx is the API answering as designed (validation,
 * permissions), and status 0 is as often the visitor's connection as our
 * fault. The response body is never attached: it can carry user data.
 */
@Injectable()
export class ErrorReportInterceptor implements HttpInterceptor {
  intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    return next.handle(request).pipe(
      catchError((error: unknown) => {
        const path = error instanceof HttpErrorResponse && error.status >= 500 ? ownPath(error.url ?? request.url) : null;
        if (error instanceof HttpErrorResponse && path !== null) {
          const route = routeOf(path);
          // A new error naming the route only: the HttpErrorResponse's message
          // carries the full URL, query string (and any token in it) included.
          const report = new Error(`HTTP ${error.status} ${request.method} ${route}`);
          report.name = 'HttpServerError';
          sentry.captureException(report, {
            tags: { http_status: String(error.status), http_method: request.method },
            // One issue per route and status, not one per listing id.
            fingerprint: ['http-5xx', request.method, String(error.status), route],
            extra: { route },
          });
        }
        return throwError(() => error);
      }),
    );
  }
}

/**
 * The path of a URL on this site, or null for another origin. A failed
 * response's url is the absolute one the browser fetched
 * (https://unibooks.app/api/v1/...); comparing it as a string with the
 * relative backendUrl never matched, and no 5xx was ever reported.
 */
function ownPath(url: string): string | null {
  try {
    const parsed = new URL(url, location.origin);
    return parsed.origin === location.origin ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/** The API path with ids collapsed: /api/v1/listings/42 -> /listings/:id */
function routeOf(path: string): string {
  const base = new URL(environment.backendUrl, location.origin).pathname.replace(/\/+$/, '');
  const rest = base && path.startsWith(base) ? path.slice(base.length) || '/' : path;
  return rest.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27})(?=\/|$)/gi, '/:id');
}
