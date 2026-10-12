import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { GoogleAnalyticsService } from './google-analytics.service';
import { RegionService } from '../region.service';

const HKD = { code: 'HKD', symbol: 'HK$', decimal_places: 2, symbol_position: 'prefix' as const };
const TWD = { code: 'TWD', symbol: 'NT$', decimal_places: 0, symbol_position: 'prefix' as const };

describe('GoogleAnalyticsService', () => {
  let gtag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    gtag = vi.fn();
    (window as any).gtag = gtag;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
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
});
