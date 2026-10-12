import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import * as Sentry from '@sentry/angular';
import { ErrorReportInterceptor } from './error-report.interceptor';
import { environment } from '../../environments/environment';

vi.mock('@sentry/angular', () => ({ captureException: vi.fn() }));

describe('ErrorReportInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: HTTP_INTERCEPTORS, useClass: ErrorReportInterceptor, multi: true },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  const failWith = (url: string, status: number, method = 'GET') => {
    let thrown: unknown;
    http.request(method, url).subscribe({ error: e => (thrown = e) });
    backend.expectOne(() => true).flush({ secret: 'body' }, { status, statusText: 'x' });
    return thrown;
  };

  it('reports a 5xx from our backend and still passes the error on', () => {
    const thrown = failWith('/orders/', 500, 'POST');
    expect(thrown).toBeTruthy();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const options = vi.mocked(Sentry.captureException).mock.calls[0][1] as any;
    expect(options.tags).toEqual({ http_status: '500', http_method: 'POST' });
    expect(JSON.stringify(options)).not.toContain('secret');
  });

  it('groups by route, not by record id or query string', () => {
    failWith('/listings/123/?lang=en', 502);
    const options = vi.mocked(Sentry.captureException).mock.calls[0][1] as any;
    expect(options.fingerprint).toEqual(['http-5xx', 'GET', '502', '/listings/:id/']);
  });

  it.each([400, 401, 403, 404, 429, 0])('does not report %s', status => {
    failWith('/listings/', status);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('ignores 5xx from other origins', () => {
    failWith('https://elsewhere.example/api/', 500);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports absolute URLs under the backend', () => {
    failWith(`${environment.backendUrl}/books/`, 503);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
