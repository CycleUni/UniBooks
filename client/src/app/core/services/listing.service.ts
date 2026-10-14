import { Injectable, inject, effect } from '@angular/core';
import { HttpClient, HttpParams, HttpContext } from '@angular/common/http';
import { Observable, from, throwError } from 'rxjs';
import { shareReplay, catchError, switchMap } from 'rxjs/operators';
import { uploadImage } from '../upload';
import { I18nService } from '../i18n.service';
import { SKIP_AUTH } from '../auth.interceptor';
import { importOrReload } from '../chunk-recovery';

@Injectable({
  providedIn: 'root'
})
export class ListingService {
  private http = inject(HttpClient);
  private apiUrl = '/listings/';

  /** Public listing endpoints don't need auth — an expired token would
   * cause SimpleJWT to reject the request even though the view is AllowAny. */
  private readonly publicCtx = new HttpContext().set(SKIP_AUTH, true);

  private readonly CACHE_TTL_MS = 60_000;
  private cache = new Map<string, Observable<any[]>>();
  private cacheTimestamps = new Map<string, number>();
  private i18n = inject(I18nService);

  constructor() {
    effect(() => {
      this.i18n.lang();
      this.clearCache();
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
      const request = this.http.get<any>('/listings/', { params, context: this.publicCtx }).pipe(
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

  getRecentBooks(school?: string, page: number = 1, limit: number = 20): Observable<any> {
    let params = new HttpParams().set('page', page.toString()).set('limit', limit.toString());
    if (school) {
      params = params.set('school', school);
    }
    return this.http.get<any>(`${this.apiUrl}recent_books/`, { params, context: this.publicCtx });
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
    return this.http.get<any>(`${this.apiUrl}${id}/`, { context: this.publicCtx });
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
      switchMap(compressed => uploadImage(this.http, `${this.apiUrl}uploads/`, compressed))
    );
  }

  updateListing(id: string | number, listingData: any): Observable<any> {
    return this.http.patch<any>(`${this.apiUrl}${id}/`, listingData);
  }

  deleteListing(id: string | number): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}${id}/`);
  }

  reportListing(listingId: string | number, reason: 'fake' | 'scam' | 'other', detail?: string): Observable<any> {
    return this.http.post<any>('/moderation/', { listing: listingId, reason, detail: detail || '' });
  }

  deletePhoto(url: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}uploads/`, { params: { url } });
  }
}
