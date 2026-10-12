import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { CheckoutComponent } from './checkout';
import { ListingService } from '../../core/services/listing.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';

// The order form sits inside the grid that only renders with a listing, so
// a failed load used to leave the page as a bare title.
describe('CheckoutComponent load failures', () => {
  let getListing: ReturnType<typeof vi.fn>;

  const open = () => {
    TestBed.configureTestingModule({
      imports: [CheckoutComponent, HttpClientTestingModule],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'l1' })) } },
        { provide: ListingService, useValue: { getListing } },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { region: () => 'tw', currency: () => ({ code: 'TWD', decimal_places: 0 }) } },
        { provide: GoogleAnalyticsService, useValue: { trackBeginCheckout: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(CheckoutComponent);
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(() => { getListing = vi.fn(); });

  it('offers a retry when the listing fails to load, and recovers on it', () => {
    getListing.mockReturnValueOnce(throwError(() => ({ status: 503 })));
    const fixture = open();
    const page: HTMLElement = fixture.nativeElement;
    expect(page.querySelector('ui-error-state')?.textContent).toContain('common.loadFailed');

    getListing.mockReturnValue(of({ id: 'l1', book_title: 'Calculus', price: 300, currency: 'TWD' }));
    (page.querySelector('ui-error-state button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(page.querySelector('ui-error-state')).toBeNull();
    expect(page.querySelector('.checkout-grid')).not.toBeNull();
  });

  it('says the listing is gone on a 404', () => {
    getListing.mockReturnValue(throwError(() => ({ status: 404 })));
    const page: HTMLElement = open().nativeElement;
    expect(page.querySelector('ui-empty')?.textContent).toContain('listing.notFoundTitle');
    expect(page.querySelector('ui-error-state')).toBeNull();
  });
});
