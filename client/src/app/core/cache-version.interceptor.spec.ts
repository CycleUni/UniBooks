import { TestBed } from '@angular/core/testing';
import {
  HTTP_INTERCEPTORS,
  HttpClient,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CacheVersionInterceptor, CacheVersionService } from './cache-version.interceptor';

describe('CacheVersionInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  function setUp() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: HTTP_INTERCEPTORS, useClass: CacheVersionInterceptor, multi: true },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  }

  beforeEach(() => {
    localStorage.clear();
    setUp();
  });

  afterEach(() => backend.verify());

  it('adds nothing before any write has named a version', () => {
    http.get('/api/v1/core/metadata').subscribe();
    expect(backend.expectOne('/api/v1/core/metadata').request.params.has('v')).toBe(false);
  });

  it('sends the versions a write reported on the public lists they cover', () => {
    http.post('/api/v1/admin/categories', {}).subscribe();
    backend
      .expectOne('/api/v1/admin/categories')
      .flush({}, { headers: { 'X-Cache-Version': 'ref=abc, search=def' } });

    http.get('/api/v1/core/metadata').subscribe();
    http.get('/api/v1/core/regions').subscribe();
    http.get('/api/v1/search/courses').subscribe();
    http.get('/api/v1/listings').subscribe();
    expect(
      backend.expectOne((r) => r.url === '/api/v1/core/metadata').request.params.get('v'),
    ).toBe('abc');
    expect(backend.expectOne((r) => r.url === '/api/v1/core/regions').request.params.get('v')).toBe(
      'abc',
    );
    expect(
      backend.expectOne((r) => r.url === '/api/v1/search/courses').request.params.get('v'),
    ).toBe('def');
    expect(backend.expectOne((r) => r.url === '/api/v1/listings').request.params.has('v')).toBe(
      false,
    );
  });

  it('remembers the versions across page loads', () => {
    TestBed.inject(CacheVersionService).note('ref=xyz');
    setUp();

    expect(TestBed.inject(CacheVersionService).versions()).toEqual({ ref: 'xyz' });
  });
});
