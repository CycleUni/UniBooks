import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { sentry } from './sentry';
import { ErrorReportInterceptor } from './error-report.interceptor';
import { ClarityService } from './services/clarity.service';
import { environment } from '../../environments/environment';


describe('ErrorReportInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let clarity: { event: ReturnType<typeof vi.fn>; upgrade: ReturnType<typeof vi.fn> };

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    clarity = { event: vi.fn(), upgrade: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: ClarityService, useValue: clarity },
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

  it('marks the Clarity session on a 5xx, and only then', () => {
    failWith('/orders', 400);
    expect(clarity.event).not.toHaveBeenCalled();
    failWith('/orders', 503);
    expect(clarity.event.mock.calls).toEqual([['api_error']]);
    expect(clarity.upgrade.mock.calls).toEqual([['api_error']]);
  });

  it('reports a 5xx from our backend and still passes the error on', () => {
    const thrown = failWith('/orders', 500, 'POST');
    expect(thrown).toBeTruthy();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const options = vi.mocked(sentry.captureException).mock.calls[0][1] as any;
    expect(options.tags).toEqual({ http_status: '500', http_method: 'POST' });
    expect(JSON.stringify(options)).not.toContain('secret');
  });

  it('groups by route, not by record id or query string', () => {
    failWith('/listings/123?lang=en', 502);
    const options = vi.mocked(sentry.captureException).mock.calls[0][1] as any;
    expect(options.fingerprint).toEqual(['http-5xx', 'GET', '502', '/listings/:id']);
  });

  it.each([400, 401, 403, 404, 429, 0])('does not report %s', status => {
    failWith('/listings', status);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('ignores 5xx from other origins', () => {
    failWith('https://elsewhere.example/api/', 500);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports URLs under the backend', () => {
    failWith(`${environment.backendUrl}/books`, 503);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('reports the absolute URL a failed response carries, without its query string', () => {
    failWith(`${location.origin}/api/v1/listings/42?email_change_token=secret-token`, 500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, options] = vi.mocked(sentry.captureException).mock.calls[0] as [Error, any];
    expect(options.fingerprint).toEqual(['http-5xx', 'GET', '500', '/listings/:id']);
    expect(error.message).toBe('HTTP 500 GET /listings/:id');
    expect(JSON.stringify(options) + error.message).not.toContain('secret-token');
  });
});
