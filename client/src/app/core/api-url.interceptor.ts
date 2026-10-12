import { Injectable, Injector, inject } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpContextToken } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { I18nService } from './i18n.service';
import { RegionService } from './region.service';

/** Skip the `lang` query param for endpoints whose response has no localized fields. */
export const SKIP_LANG_PARAM = new HttpContextToken<boolean>(() => false);

@Injectable()
export class ApiUrlInterceptor implements HttpInterceptor {
  private i18n = inject(I18nService);
  // Resolved lazily, not with inject() at field level. RegionService injects
  // HttpClient (it fetches /core/regions/), and HttpClient construction needs
  // HTTP_INTERCEPTORS — so injecting it here closed a DI cycle and Angular
  // failed the whole interceptor chain with NG0200, taking every API call
  // down with it. By the time intercept() runs the injector is fully built.
  private injector = inject(Injector);
  private _regionService?: RegionService;

  private get regionService(): RegionService {
    if (!this._regionService) {
      this._regionService = this.injector.get(RegionService);
    }
    return this._regionService;
  }

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    if (!request.url.startsWith('http')) {
      const currentLang = this.i18n.lang();
      const currentRegion = this.regionService.region();

      // Region, language and the service-worker bypass all travel as query
      // parameters rather than custom headers. An X-Region or ngsw-bypass
      // header made even a public GET a "non-simple" cross-origin request, so
      // the browser sent a CORS preflight ahead of it — and the preflight
      // cache is per URL, so nearly every call with new parameters paid for
      // a second round trip to the backend. ?region= and ?lang= already
      // outrank the headers there (core.region.get_region, resolve_language);
      // Accept-Language is a CORS-safelisted header and stays.
      const setParams: { [key: string]: string } = { 'ngsw-bypass': '' };
      if (!request.params.has('region')) {
        setParams['region'] = currentRegion;
      }
      if (!request.context.get(SKIP_LANG_PARAM) && !request.params.has('lang')) {
        setParams['lang'] = currentLang;
      }

      let headers = request.headers;
      if (!headers.has('Accept-Language')) {
        headers = headers.set('Accept-Language', request.params.get('lang') || currentLang);
      }

      request = request.clone({
        url: `${environment.backendUrl}${request.url}`,
        headers,
        setParams,
      });
    }
    return next.handle(request);
  }
}
