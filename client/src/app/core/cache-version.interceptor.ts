import { Injectable, inject, signal } from '@angular/core';
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/** The backend's cache namespaces (server/src/lib/cache.ts). */
export type CacheNamespace = 'ref' | 'search';
export type CacheVersions = Partial<Record<CacheNamespace, string>>;

const STORAGE_KEY = 'ub_cache_v';

/** The public lists each namespace covers, by API path. */
const VERSIONED_PATHS: Array<[RegExp, CacheNamespace]> = [
  [/\/core\/(metadata|regions)$/, 'ref'],
  [/\/search\/courses$/, 'search'],
];

/**
 * The cache versions an admin write reported (X-Cache-Version), kept in
 * localStorage so every tab of this browser uses them.
 */
@Injectable({ providedIn: 'root' })
export class CacheVersionService {
  readonly versions = signal<CacheVersions>(read());

  /** Record the versions an `X-Cache-Version: ref=…, search=…` header names. */
  note(header: string): void {
    const next: CacheVersions = { ...this.versions() };
    for (const part of header.split(',')) {
      const [ns, value] = part.trim().split('=');
      if ((ns === 'ref' || ns === 'search') && value) next[ns] = value;
    }
    this.versions.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode or blocked storage: this tab still has them.
    }
  }
}

function read(): CacheVersions {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Browsers keep the public lists (categories, schools, regions, course
 * facets) for minutes. After an admin write the backend names new cache
 * versions; sending one as `?v=` gives these requests a new URL, so the
 * browser that made the change asks again instead of showing its old copy,
 * and the backend answers from the new version.
 */
@Injectable()
export class CacheVersionInterceptor implements HttpInterceptor {
  private versions = inject(CacheVersionService);

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    if (request.method === 'GET' && !request.params.has('v')) {
      const path = request.url.split('?')[0];
      const ns = VERSIONED_PATHS.find(([pattern]) => pattern.test(path))?.[1];
      const v = ns && this.versions.versions()[ns];
      if (v) request = request.clone({ setParams: { v } });
    }
    return next.handle(request).pipe(
      tap((event) => {
        const header = event instanceof HttpResponse ? event.headers.get('X-Cache-Version') : null;
        if (header) this.versions.note(header);
      }),
    );
  }
}
