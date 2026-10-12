import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import * as Sentry from '@sentry/angular';
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
        if (error instanceof HttpErrorResponse && error.status >= 500 && isOwnBackend(error.url ?? request.url)) {
          const path = routeOf(error.url ?? request.url);
          Sentry.captureException(error, {
            tags: { http_status: String(error.status), http_method: request.method },
            // One issue per route and status, not one per listing id.
            fingerprint: ['http-5xx', request.method, String(error.status), path],
            extra: { route: path },
          });
        }
        return throwError(() => error);
      }),
    );
  }
}

function isOwnBackend(url: string): boolean {
  return !url.startsWith('http') || url.startsWith(environment.backendUrl);
}

/** The path without the query string, with ids collapsed: /listings/42/ -> /listings/:id/ */
function routeOf(url: string): string {
  const path = url.replace(environment.backendUrl, '').split(/[?#]/)[0];
  return path.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27})(?=\/|$)/gi, '/:id');
}
