import { Injectable, inject, effect } from '@angular/core';
import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Observable, defer, throwError, timer } from 'rxjs';
import { catchError, retry, shareReplay } from 'rxjs/operators';
import { SKIP_AUTH } from '../auth.interceptor';
import { I18nService } from '../i18n.service';
import { isTransientHttpFailure } from '../http-failure';
import { RegionService } from '../region.service';

export interface PublicAd {
  id: number;
  title: string;
  image_url: string;
  target_url: string;
  headline?: string;
  subheadline?: string;
  advertiser_name?: string;
  slot_index: number;
  labels?: string[];
  show_in_hero?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class MetadataService {
  private http = inject(HttpClient);
  private i18n = inject(I18nService);
  private regionService = inject(RegionService);

  // The layout shell and the home page both ask for the homepage metadata on
  // load, so without this every visit fired the same request twice. Entries
  // are keyed by school and dropped after a minute (the backend caches the
  // same payload far longer) or when the language changes, since the
  // response is localized.
  private static readonly METADATA_TTL_MS = 60_000;
  private metadataCache = new Map<string, { at: number; request$: Observable<any> }>();

  constructor() {
    effect(() => {
      this.i18n.lang();
      this.metadataCache.clear();
    });
  }

  getMetadata(schoolId?: string | number): Observable<any> {
    // Keyed by region too: ApiUrlInterceptor adds the current region to the
    // request, so the same school parameter means a different school list in
    // Taiwan and in Hong Kong. Without it, arriving at /hk with Taiwan
    // remembered served Taiwan's schools from this cache (or from the request
    // that was already in flight) to the Hong Kong school selector.
    const key = `${this.regionService.region()}|${schoolId ? String(schoolId) : ''}`;
    const hit = this.metadataCache.get(key);
    if (hit && Date.now() - hit.at < MetadataService.METADATA_TTL_MS) {
      return hit.request$;
    }

    // Public endpoint — do not attach Bearer token (SKIP_AUTH).
    // The `lang` query param is appended by ApiUrlInterceptor.
    let params = new HttpParams();
    if (schoolId) {
      params = params.set('school', String(schoolId));
    }
    const request$ = this.http.get<any>('/core/metadata/', {
      context: new HttpContext().set(SKIP_AUTH, true),
      params
    }).pipe(
      catchError(err => {
        // Never cache a failure: the next caller retries.
        this.metadataCache.delete(key);
        return throwError(() => err);
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );
    this.metadataCache.set(key, { at: Date.now(), request$ });
    return request$;
  }

  /** Same schedule as the profile and notification-hub retries. */
  private static readonly RETRY_DELAYS_MS = [3000, 10000, 30000];

  /**
   * getMetadata(), asking again after a failure to reach the backend — on a
   * cold serverless start the first request can fail while one seconds later
   * succeeds. For callers with no error state of their own to show: the layout
   * shell's school selector and the sell page's category list used to stay
   * empty for the rest of the visit after a single failed request.
   *
   * Each attempt goes back through getMetadata(), so it shares a request
   * another caller has made in the meantime rather than firing its own. A
   * real answer (4xx) is not retried. Unsubscribing stops the schedule.
   */
  getMetadataWithRetry(schoolId?: string | number): Observable<any> {
    return defer(() => this.getMetadata(schoolId)).pipe(
      retry({
        count: MetadataService.RETRY_DELAYS_MS.length,
        delay: (err, attempt) => isTransientHttpFailure(err)
          ? timer(MetadataService.RETRY_DELAYS_MS[attempt - 1])
          : throwError(() => err),
      })
    );
  }

  getActiveAds(position: string = 'home_banner', schoolId?: string | number): Observable<any> {
    let params = new HttpParams().set('position', position);
    if (schoolId) {
      params = params.set('school', String(schoolId));
    }
    // Endpoint renamed from '/ads/active/' to '/promotions/active/' to evade adblockers
    return this.http.get<any>('/promotions/active/', {
      context: new HttpContext().set(SKIP_AUTH, true),
      params
    });
  }

  recordAdView(id: number): Observable<any> {
    return this.http.post<any>(`/promotions/${id}/view/`, {}, {
      context: new HttpContext().set(SKIP_AUTH, true)
    });
  }

  recordAdClick(id: number): Observable<any> {
    return this.http.post<any>(`/promotions/${id}/click/`, {}, {
      context: new HttpContext().set(SKIP_AUTH, true)
    });
  }
}
