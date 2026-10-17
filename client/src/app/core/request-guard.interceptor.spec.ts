import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, HttpErrorResponse, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RequestGuardInterceptor } from './request-guard.interceptor';

describe('RequestGuardInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: HTTP_INTERCEPTORS, useClass: RequestGuardInterceptor, multi: true },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => vi.useRealTimers());

  it('cuts off a loop: past 40 calls in 10s the rest never reach the network', () => {
    for (let i = 0; i < 40; i++) http.get(`/listings?page=${i}`).subscribe();
    expect(backend.match(() => true)).toHaveLength(40);

    let status = 0;
    http.get('/listings').subscribe({ error: (e: HttpErrorResponse) => (status = e.status) });
    backend.expectNone(() => true);
    expect(status).toBe(429);
  });

  it('lets the endpoint through again once the window has passed', async () => {
    for (let i = 0; i < 40; i++) http.get('/listings').subscribe();
    backend.match(() => true);
    await vi.advanceTimersByTimeAsync(10_001);
    http.get('/listings').subscribe();
    backend.expectOne('/listings');
  });

  it('counts each endpoint on its own', () => {
    for (let i = 0; i < 40; i++) http.get('/listings').subscribe();
    backend.match(() => true);
    http.get('/books').subscribe();
    backend.expectOne('/books');
  });

  it('holds an endpoint off for the Retry-After after a 429', async () => {
    http.get('/search').subscribe({ error: () => {} });
    backend.expectOne('/search').flush({}, { status: 429, statusText: 'x', headers: { 'Retry-After': '5' } });

    let status = 0;
    http.get('/search').subscribe({ error: (e: HttpErrorResponse) => (status = e.status) });
    backend.expectNone('/search');
    expect(status).toBe(429);

    await vi.advanceTimersByTimeAsync(5001);
    http.get('/search').subscribe();
    backend.expectOne('/search');
  });

  it('leaves absolute URLs (chat, third parties) alone', () => {
    for (let i = 0; i < 50; i++) http.get('https://example.com/x').subscribe();
    expect(backend.match(() => true)).toHaveLength(50);
  });
});
