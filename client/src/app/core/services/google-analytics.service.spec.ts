import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { GoogleAnalyticsService } from './google-analytics.service';
import { RegionService } from '../region.service';
import { ClarityService } from './clarity.service';
import { MAX_WAIT_MS } from '../page-settled';
import { environment } from '../../../environments/environment';

const HKD = { code: 'HKD', symbol: 'HK$', decimal_places: 2, symbol_position: 'prefix' as const };
const TWD = { code: 'TWD', symbol: 'NT$', decimal_places: 0, symbol_position: 'prefix' as const };

describe('GoogleAnalyticsService', () => {
  let gtag: ReturnType<typeof vi.fn>;
  let clarity: { event: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn>; upgrade: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    TestBed.resetTestingModule();
    gtag = vi.fn();
    (window as any).gtag = gtag;
    clarity = { event: vi.fn(), set: vi.fn(), identify: vi.fn(), upgrade: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ClarityService, useValue: clarity },
        {
          provide: RegionService,
          useValue: {
            region: signal('hk'),
            currency: signal(HKD),
            regions: signal([{ code: 'TW', currency: TWD }, { code: 'HK', currency: HKD }]),
          },
        },
      ],
    });
  });

  afterEach(() => {
    delete (window as any).gtag;
  });

  function events(name: string): Record<string, any>[] {
    return gtag.mock.calls.filter(c => c[0] === 'event' && c[1] === name).map(c => c[2]);
  }

  it('tags every event with the site region', () => {
    TestBed.inject(GoogleAnalyticsService).trackEvent('anything', { a: 1 });
    expect(events('anything')).toEqual([{ region: 'HK', a: 1 }]);
  });

  it('forwards event names to Clarity, keeping the replays of funnel steps', () => {
    const ga = TestBed.inject(GoogleAnalyticsService);
    ga.trackSearch('calculus', 3);
    ga.trackPlaceOrder({ id: 'o1', total_amount: 100, currency: 'HKD' });
    expect(clarity.event.mock.calls).toEqual([['search'], ['place_order']]);
    expect(clarity.upgrade.mock.calls).toEqual([['place_order']]);
  });

  it('identifies the user and tags sign-in and verification in Clarity', () => {
    const ga = TestBed.inject(GoogleAnalyticsService);
    ga.setUserId(42);
    ga.setUserProperties({ verified_region_count: 1 });
    ga.setUserId(null);
    expect(clarity.identify.mock.calls).toEqual([['42']]);
    expect(clarity.set.mock.calls).toEqual([['logged_in', 'true'], ['verified', 'true'], ['logged_in', 'false']]);
  });

  it('sends money in major units of the order currency', () => {
    const ga = TestBed.inject(GoogleAnalyticsService);
    ga.trackPurchase({ id: 'o1', listing: 'l1', listing_title: 'Calculus', total_amount: 12050, currency: 'HKD' });
    ga.trackPurchase({ id: 'o2', listing: 'l2', total_amount: 300, currency: 'TWD' });
    const [hk, tw] = events('purchase');
    expect(hk).toMatchObject({ transaction_id: 'o1', currency: 'HKD', value: 120.5 });
    expect(hk['items'][0]).toMatchObject({ item_id: 'l1', item_name: 'Calculus', price: 120.5 });
    expect(tw).toMatchObject({ currency: 'TWD', value: 300 });
  });

  it('falls back to the current region currency when none is given', () => {
    TestBed.inject(GoogleAnalyticsService).trackViewItem({ bookId: 7, price: 5000 });
    expect(events('view_item')[0]).toMatchObject({ currency: 'HKD', value: 50 });
  });

  it('records an order request as place_order, not as a purchase', () => {
    TestBed.inject(GoogleAnalyticsService).trackPlaceOrder({ id: 'o3', listing: 'l3', total_amount: 100, currency: 'TWD' });
    expect(events('purchase')).toEqual([]);
    expect(events('place_order')[0]).toMatchObject({ order_id: 'o3', value: 100, currency: 'TWD', region: 'HK' });
  });

  it('names the order steps between request and purchase', () => {
    const ga = TestBed.inject(GoogleAnalyticsService);
    ga.trackOrderStep('o4', 'accepted');
    ga.trackOrderStep('o4', 'handed_over');
    expect(events('order_accepted')).toHaveLength(1);
    expect(events('order_handed_over')).toHaveLength(1);
  });

  it('records book views with how many listings the book has', () => {
    TestBed.inject(GoogleAnalyticsService).trackViewBook({ id: 9, isbn: '9780000000009', title: 'Physics', listingCount: 0 });
    expect(events('view_book')[0]).toMatchObject({ item_id: '9780000000009', item_name: 'Physics', listing_count: 0 });
  });

  it('does nothing when gtag is not loaded', () => {
    delete (window as any).gtag;
    expect(() => TestBed.inject(GoogleAnalyticsService).trackRequestBook(1, 'book')).not.toThrow();
  });

  describe('the gtag script', () => {
    const ownTag = () => document.querySelector('script[src^="/metrics/gtag/js"]');
    // Past whenPageSettled however the test app reports stable: its cap, then
    // the idle wait.
    const settled = () => vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 3000);

    // The test environment has no measurement ID, which leaves GA off.
    const configuredId = environment.gaMeasurementId;
    beforeEach(() => {
      environment.gaMeasurementId = 'G-TEST';
      vi.useFakeTimers();
    });
    afterEach(() => {
      environment.gaMeasurementId = configuredId;
      vi.useRealTimers();
      document.head.querySelectorAll('script[src^="/metrics/"]').forEach(el => el.remove());
    });

    it('is not loaded again when the tag gateway already added it', async () => {
      const injected = document.createElement('script');
      injected.src = '/metrics/';
      document.head.appendChild(injected);
      TestBed.inject(GoogleAnalyticsService);
      await settled();
      expect(ownTag()).toBeNull();
    });

    it('is loaded through the gateway path when the page has no tag', async () => {
      TestBed.inject(GoogleAnalyticsService);
      await settled();
      expect(ownTag()?.getAttribute('src')).toBe('/metrics/gtag/js?id=G-TEST');
    });
  });
});
