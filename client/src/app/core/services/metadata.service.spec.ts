import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MetadataService } from './metadata.service';
import { I18nService } from '../i18n.service';
import { RegionService } from '../region.service';

/**
 * getMetadataWithRetry is for callers with no error state of their own — the
 * layout's school selector, the sell page's categories — which used to stay
 * empty for the rest of the visit after one failed request.
 */
describe('MetadataService.getMetadataWithRetry', () => {
  let service: MetadataService;
  let httpMock: HttpTestingController;
  const requests = () => httpMock.match(req => req.url === '/core/metadata/');
  const unavailable = { status: 503, statusText: 'Service Unavailable' };

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: I18nService, useValue: { lang: signal('en') } },
      ],
    });
    service = TestBed.inject(MetadataService);
    httpMock = TestBed.inject(HttpTestingController);
    // The service clears its cache from an effect on the language. In the app
    // that effect's first run is long past; here it would otherwise land in
    // the middle of a test and wipe the cache the test relies on.
    TestBed.tick();
  });

  afterEach(() => vi.useRealTimers());

  it('asks again after a transient failure and delivers the metadata', () => {
    let data: any = null;
    service.getMetadataWithRetry().subscribe(d => (data = d));

    requests()[0].flush({}, unavailable);
    expect(data).toBeNull();

    vi.advanceTimersByTime(3000);
    requests()[0].flush({ schools: [{ id: 1 }] });

    expect(data).toEqual({ schools: [{ id: 1 }] });
  });

  it('keeps to a bounded schedule, then reports the failure', () => {
    let error: any = null;
    service.getMetadataWithRetry().subscribe({ error: e => (error = e) });

    let attempts = 0;
    for (let second = 0; second < 120; second++) {
      for (const req of requests()) {
        attempts++;
        req.flush({}, unavailable);
      }
      vi.advanceTimersByTime(1000);
    }

    expect(attempts).toBe(4);   // first try + 3 retries
    expect(error?.status).toBe(503);
  });

  it('does not retry a real answer', () => {
    let error: any = null;
    service.getMetadataWithRetry().subscribe({ error: e => (error = e) });

    requests()[0].flush({}, { status: 404, statusText: 'Not Found' });
    vi.advanceTimersByTime(60_000);

    expect(requests()).toEqual([]);
    expect(error?.status).toBe(404);
  });

  it('shares a request another caller made while it was waiting', () => {
    service.getMetadataWithRetry().subscribe();
    requests()[0].flush({}, unavailable);

    // Someone else asks during the wait; the retry then finds their request.
    service.getMetadata().subscribe();
    vi.advanceTimersByTime(3000);

    expect(requests().length).toBe(1);
  });

  it('stops its schedule when unsubscribed', () => {
    const subscription = service.getMetadataWithRetry().subscribe();
    requests()[0].flush({}, unavailable);

    subscription.unsubscribe();
    vi.advanceTimersByTime(60_000);

    expect(requests()).toEqual([]);
  });
});

/**
 * The school list differs per region while the request's parameters do not
 * (ApiUrlInterceptor adds the region), so a cache keyed on the school alone
 * served Taiwan's schools to a visitor who had just landed on /hk.
 */
describe('MetadataService cache', () => {
  it('does not share a cached response between regions', () => {
    const region = signal('tw');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: I18nService, useValue: { lang: signal('en') } },
        { provide: RegionService, useValue: { region } },
      ],
    });
    const service = TestBed.inject(MetadataService);
    const httpMock = TestBed.inject(HttpTestingController);
    TestBed.tick();

    let tw: any = null;
    service.getMetadata().subscribe(d => (tw = d));
    httpMock.expectOne(req => req.url === '/core/metadata/').flush({ schools: [{ code: 'HKU', name: 'Hungkuang' }] });

    region.set('hk');
    let hk: any = null;
    service.getMetadata().subscribe(d => (hk = d));
    httpMock.expectOne(req => req.url === '/core/metadata/').flush({ schools: [{ code: 'HKU', name: 'The University of Hong Kong' }] });

    expect(tw.schools[0].name).toBe('Hungkuang');
    expect(hk.schools[0].name).toBe('The University of Hong Kong');
    httpMock.verify();
  });
});
