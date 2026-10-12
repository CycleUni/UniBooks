import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RetryInterceptor } from './retry.interceptor';

describe('RetryInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: HTTP_INTERCEPTORS, useClass: RetryInterceptor, multi: true },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => vi.useRealTimers());

  const fail = (status: number) => backend.expectOne(() => true).flush({}, { status, statusText: 'x' });

  it('retries a GET that failed with a server error', async () => {
    let result: unknown = null;
    http.get('/listings/').subscribe(r => (result = r));
    fail(503);
    await vi.advanceTimersByTimeAsync(5000);
    backend.expectOne('/listings/').flush({ ok: true });
    expect(result).toEqual({ ok: true });
  });

  it.each(['POST', 'PATCH', 'DELETE'])('never replays a %s', async (method) => {
    // A 504 or a dropped connection after the backend already did the work:
    // replaying would create a second order or listing.
    let failed = false;
    http.request(method, '/orders/', { body: {} }).subscribe({ error: () => (failed = true) });
    fail(504);
    await vi.advanceTimersByTimeAsync(10_000);
    backend.expectNone(() => true);
    expect(failed).toBe(true);
  });
});
