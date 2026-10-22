import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { ListingDetail } from './listing-detail';

// Only a 404 means the listing is gone; any other failure used to read
// "book not found" with no way to try again.
describe('ListingDetail load failures', () => {
  let component: ListingDetail;
  let getListing: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ListingDetail, HttpClientTestingModule], providers: [provideRouter([])] });
    component = TestBed.createComponent(ListingDetail).componentInstance;
    getListing = vi.fn();
    (component as any).listingService = { getListing };
    (component as any).i18n = { t: (k: string) => k, lang: () => 'en' };
    (component as any).ga = { trackViewItem: vi.fn() };
    component.currentId = 'l1';
  });

  it('offers a retry on a non-404, not "not found"', () => {
    getListing.mockReturnValue(throwError(() => ({ status: 503 })));
    component.startLoad('l1');
    expect(component.errorMsg).toBe('common.loadFailed');
    expect(component.notFound).toBe(false);
    expect(component.isLoading).toBe(false);
  });

  it('says the listing is gone on a 404', () => {
    getListing.mockReturnValue(throwError(() => ({ status: 404 })));
    component.startLoad('l1');
    expect(component.notFound).toBe(true);
    expect(component.errorMsg).toBe('');
  });

  it('keeps a listing on screen when reloading it fails', () => {
    component.listing = { id: 'l1', book_title: 'Calculus' };
    getListing.mockReturnValue(throwError(() => ({ status: 503 })));
    component.startLoad('l1');
    expect(component.listing).not.toBeNull();
    expect(component.errorMsg).toBe('');
  });

  it("ignores a slower answer for the listing the visitor already left", () => {
    const first = new Subject<any>();
    const second = new Subject<any>();
    getListing.mockReturnValueOnce(first).mockReturnValueOnce(second);
    component.currentId = 'l1';
    component.startLoad('l1');
    component.currentId = 'l2';
    component.startLoad('l2');

    second.next({ id: 'l2', book_title: 'Second', photos: [] });
    first.next({ id: 'l1', book_title: 'First', photos: [] });

    expect(component.listing?.id).toBe('l2');
  });
});

