import { Injectable } from '@angular/core';
import { HttpErrorResponse, HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';

/** More than this many calls to one endpoint within BURST_WINDOW_MS is a loop, not a user. */
const BURST_LIMIT = 40;
const BURST_WINDOW_MS = 10_000;
/** How long to hold off an endpoint after the backend said 429 with no (or a huge) Retry-After. */
const DEFAULT_COOLDOWN_MS = 10_000;
const MAX_COOLDOWN_MS = 60_000;

/**
 * RequestGuardInterceptor — keeps a front-end bug from hammering the API.
 *
 * Two protections, per endpoint (method + path, query ignored):
 * - Burst breaker: a component stuck in a render → fetch → state change →
 *   render loop would otherwise send requests as fast as the browser allows.
 *   Past BURST_LIMIT calls in BURST_WINDOW_MS, further calls fail locally with
 *   a 429 and never leave the browser.
 * - 429 cool-down: once the backend answers 429, calls to that endpoint fail
 *   locally until its Retry-After has passed, instead of asking again at once.
 *
 * The locally generated failure is an HttpErrorResponse with status 429, so
 * callers handle it exactly like the backend's own throttle answer.
 */
@Injectable()
export class RequestGuardInterceptor implements HttpInterceptor {
  private readonly hits = new Map<string, number[]>();
  private readonly coolDownUntil = new Map<string, number>();

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    const own = !request.url.startsWith('http') || request.url.startsWith(environment.backendUrl);
    if (!own) return next.handle(request);

    const key = `${request.method} ${request.url.split('?')[0]}`;
    const now = Date.now();

    const until = this.coolDownUntil.get(key) ?? 0;
    if (until > now) return this.refuse(request, Math.ceil((until - now) / 1000));
    this.coolDownUntil.delete(key);

    const recent = (this.hits.get(key) ?? []).filter(t => now - t < BURST_WINDOW_MS);
    if (recent.length >= BURST_LIMIT) {
      this.hits.set(key, recent);
      console.warn(`[guard] ${key} called ${recent.length} times in ${BURST_WINDOW_MS / 1000}s — blocking`);
      return this.refuse(request, Math.ceil(BURST_WINDOW_MS / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);

    return next.handle(request).pipe(
      catchError(error => {
        if (error instanceof HttpErrorResponse && error.status === 429) {
          this.coolDownUntil.set(key, Date.now() + this.coolDownMs(error));
        }
        return throwError(() => error);
      }),
    );
  }

  private coolDownMs(error: HttpErrorResponse): number {
    const seconds = Number(error.headers?.get('Retry-After'));
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS;
    return Math.min(ms, MAX_COOLDOWN_MS);
  }

  private refuse(request: HttpRequest<any>, waitSeconds: number): Observable<never> {
    return throwError(
      () =>
        new HttpErrorResponse({
          status: 429,
          statusText: 'Too Many Requests',
          url: request.url,
          error: { error: { code: 'common.errThrottled', wait: waitSeconds } },
        }),
    );
  }
}
