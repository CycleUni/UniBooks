import { Injectable, inject, effect } from '@angular/core';
import { HttpClient, HttpParams, HttpContext } from '@angular/common/http';
import { Observable, from, throwError } from 'rxjs';
import { shareReplay, catchError, switchMap } from 'rxjs/operators';
import { uploadImage } from '../upload';
import { I18nService } from '../i18n.service';
import { RegionService } from '../region.service';
import { SKIP_AUTH } from '../auth.interceptor';
import { importOrReload } from '../chunk-recovery';

@Injectable({
  providedIn: 'root'
})
export class ListingService {
  private http = inject(HttpClient);
  private apiUrl = '/listings';

  /** Public listing endpoints don't need auth — an expired token would
   * cause SimpleJWT to reject the request even though the view is AllowAny. */
  private readonly publicCtx = new HttpContext().set(SKIP_AUTH, true);

  private readonly CACHE_TTL_MS = 60_000;
  private cache = new Map<string, Observable<any[]>>();
  private cacheTimestamps = new Map<string, number>();
  private readonly RECENT_TTL_MS = 30_000;
  private recentCache = new Map<string, { at: number; request$: Observable<any> }>();
  private i18n = inject(I18nService);
  private regionService = inject(RegionService);

  constructor() {
    effect(() => {
      this.i18n.lang();
      this.clearCache();
      this.clearRecentBooks();
    });
  }

  getListings(school?: string, sellerId?: string, page: number = 1): Observable<any> {
    const key = (school || '') + '_' + (sellerId || '') + '_' + page;

    // Evict stale cache entry (freshness based on CACHE_TTL_MS).
    if (this.cache.has(key)) {
      const age = Date.now() - (this.cacheTimestamps.get(key) ?? 0);
      if (age > this.CACHE_TTL_MS) {
        this.cache.delete(key);
        this.cacheTimestamps.delete(key);
      }
    }

    if (!this.cache.has(key)) {
      let params = new HttpParams().set('page', page.toString());
      if (school) {
        params = params.set('school', school);
      }
      if (sellerId) {
        params = params.set('seller_id', sellerId);
      }
      const request = this.http.get<any>('/listings', { params, context: this.publicCtx }).pipe(
        catchError(err => {
          // Evict the failed entry so the next subscriber starts a fresh
          // request instead of replaying the same error to every caller.
          this.cache.delete(key);
          this.cacheTimestamps.delete(key);
          return throwError(() => err);
        }),
        shareReplay({ bufferSize: 1, refCount: true })
      );
      this.cache.set(key, request);
      this.cacheTimestamps.set(key, Date.now());
    }

    return this.cache.get(key)!;
  }

  /**
   * A page of recent books. Page 1 also carries the most-wanted list, which
   * the home page reads from the same request the listing grid makes: it is
   * shared while in flight and for a short while after, so the two cost one
   * Worker request. clearRecentBooks() forces the next call to refetch.
   */
  getRecentBooks(school?: string, page: number = 1, limit: number = 20): Observable<any> {
    // Region too: ApiUrlInterceptor adds it to the request.
    const key = `${this.regionService.region()}|${school || ''}|${page}|${limit}`;
    const hit = this.recentCache.get(key);
    if (hit && Date.now() - hit.at < this.RECENT_TTL_MS) return hit.request$;

    let params = new HttpParams().set('page', page.toString()).set('limit', limit.toString());
    if (school) {
      params = params.set('school', school);
    }
    const request$ = this.http.get<any>(`${this.apiUrl}/recent-books`, { params, context: this.publicCtx }).pipe(
      catchError(err => {
        // Never cache a failure: the next caller retries.
        this.recentCache.delete(key);
        return throwError(() => err);
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );
    this.recentCache.set(key, { at: Date.now(), request$ });
    return request$;
  }

  clearRecentBooks() {
    this.recentCache.clear();
  }

  clearCache(school?: string) {
    if (school) {
      this.cache.delete(school);
      this.cacheTimestamps.delete(school);
    } else {
      this.cache.clear();
      this.cacheTimestamps.clear();
    }
  }

  getListing(id: string | number): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/${id}`, { context: this.publicCtx });
  }

  createListing(listingData: any): Observable<any> {
    return this.http.post<any>(this.apiUrl, listingData);
  }

  // Compresses client-side, then uploads in two steps (core/upload.ts).
  uploadPhoto(file: File): Observable<{ url: string }> {
    return from(importOrReload(() => import('browser-image-compression')).then(m => m.default(file, {
      maxSizeMB: 1.5,
      maxWidthOrHeight: 1600,
      useWebWorker: true,
      fileType: 'image/webp',
    }))).pipe(
      switchMap(compressed => uploadImage(this.http, `${this.apiUrl}/uploads`, compressed))
    );
  }

  updateListing(id: string | number, listingData: any): Observable<any> {
    return this.http.patch<any>(`${this.apiUrl}/${id}`, listingData);
  }

  deleteListing(id: string | number): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/${id}`);
  }

  reportListing(listingId: string | number, reason: 'fake' | 'scam' | 'other', detail?: string): Observable<any> {
    return this.http.post<any>('/moderation', { listing: listingId, reason, detail: detail || '' });
  }

  deletePhoto(url: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/uploads`, { params: { url } });
  }
}
