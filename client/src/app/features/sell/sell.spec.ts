import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Sell, SELL_DRAFT_STORAGE_KEY, SELL_MAX_PHOTOS, SELL_DRAFT_MAX_AGE_MS, otherCopiesFromBook, isPriceFarAboveOtherCopies } from './sell';
import { provideRouter } from '@angular/router';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { BookService } from '../../core/services/book.service';
import { ListingService } from '../../core/services/listing.service';
import { MetadataService } from '../../core/services/metadata.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { Subject, of, throwError } from 'rxjs';
import { RegionService } from '../../core/region.service';


describe('otherCopiesFromBook', () => {
  it('reads the range the backend computed over every active copy', () => {
    expect(otherCopiesFromBook({ price_stats: { count: 2, min: 100, max: 10099 }, listings: { count: 2, results: [] } }))
      .toEqual({ count: 2, min: 100, max: 10099 });
  });

  it('reports nothing when no copy is listed', () => {
    expect(otherCopiesFromBook({ price_stats: { count: 0, min: null, max: null } })).toBeNull();
    expect(otherCopiesFromBook(null)).toBeNull();
    expect(otherCopiesFromBook({})).toBeNull();
  });

  it('falls back to the listings when the backend predates price_stats and sent them all', () => {
    const book = { listings: { count: 3, results: [{ price: 300 }, { price: 120 }, { price: 0 }] } };
    expect(otherCopiesFromBook(book)).toEqual({ count: 3, min: 0, max: 300 });
  });

  it('gives no range from a partial page of listings', () => {
    // 25 copies, 20 on the page: the cheapest may be one of the missing five.
    const results = Array.from({ length: 20 }, () => ({ price: 400 }));
    expect(otherCopiesFromBook({ listings: { count: 25, results } })).toBeNull();
  });
});

describe('isPriceFarAboveOtherCopies', () => {
  const copies = { count: 2, min: 100, max: 10099 };

  it('warns above 3x the cheapest listed copy, not at it', () => {
    expect(isPriceFarAboveOtherCopies(300, copies)).toBe(false);
    expect(isPriceFarAboveOtherCopies(301, copies)).toBe(true);
    expect(isPriceFarAboveOtherCopies(10099, copies)).toBe(true);
  });

  it('stays quiet without a price or anything to compare with', () => {
    expect(isPriceFarAboveOtherCopies(null, copies)).toBe(false);
    expect(isPriceFarAboveOtherCopies(NaN, copies)).toBe(false);
    expect(isPriceFarAboveOtherCopies(99999, null)).toBe(false);
  });

  it('stays quiet when the cheapest copy is free', () => {
    expect(isPriceFarAboveOtherCopies(500, { count: 2, min: 0, max: 200 })).toBe(false);
  });
});

describe('Sell Component Barcode Scanner Validation', () => {
  let fixture: ComponentFixture<Sell>;
  let component: Sell;
  let mockBookService: any;
  let mockI18n: any;

  beforeEach(async () => {
    mockBookService = {
      getEngineOptions: vi.fn().mockReturnValue([
        { label: 'Google Books', value: 'googlebooks' },
        { label: 'Open Library', value: 'openlibrary' }
      ]),
      searchBooks: vi.fn().mockReturnValue(of({ results: [] })),
      createManualBook: vi.fn().mockReturnValue(of({ id: 'book-1' }))
    };

    mockI18n = {
      t: vi.fn((key: string) => {
        const translations: Record<string, string> = {
          'sell.invalidBarcodeScanned': "Scanned code doesn't look like a valid ISBN, try again.",
          'sell.cameraPermission': 'Cannot access camera. Please check your permissions.',
          'sell.upstreamTimeout': 'External book database timed out. Please try again.',
          'sell.networkError': 'A network error occurred while searching for the book. Please try again later.',
          'sell.notFoundIsbn': 'Book with this ISBN not found. Please enter the title and author manually.'
        };
        return translations[key] || key;
      }),
      lang: () => 'en'
    };

    await TestBed.configureTestingModule({
      imports: [Sell, HttpClientTestingModule],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        provideRouter([]),
        { provide: BookService, useValue: mockBookService },
        { provide: I18nService, useValue: mockI18n },
        {
          provide: AuthStore,
          useValue: {
            isLoggedIn: () => true,
            user: () => ({ id: 'user-1' })
          }
        },
        {
          provide: AccountService,
          useValue: {
            getMyProfile: vi.fn().mockReturnValue(of({ verified_at: '2026-01-01' }))
          }
        },
        {
          provide: ListingService,
          useValue: {
            uploadPhoto: vi.fn(),
            deletePhoto: vi.fn(),
            createListing: vi.fn()
          }
        },
        {
          provide: MetadataService,
          useValue: {
            getMetadata: vi.fn().mockReturnValue(of({ categories: [] })),
            getMetadataWithRetry: vi.fn().mockReturnValue(of({ categories: [] }))
          }
        },
        {
          provide: GoogleAnalyticsService,
          useValue: {
            trackEvent: vi.fn(),
            trackPublishListing: vi.fn()
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(Sell);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('should delegate cleanAndValidateIsbn method to validation function', () => {
    expect(component.cleanAndValidateIsbn('9786264140720')).toBe('9786264140720');
    expect(component.cleanAndValidateIsbn('invalid')).toBeNull();
  });

  it('should accept valid ISBN-13 scan, assign searchQuery, stop scanner, and search', async () => {
    const stopScannerSpy = vi.spyOn(component, 'stopScanner').mockResolvedValue();
    const searchBookSpy = vi.spyOn(component, 'searchBook').mockImplementation(() => {});
    const onSearchQueryChangeSpy = vi.spyOn(component, 'onSearchQueryChange');

    component.cameraError = "Scanned code doesn't look like a valid ISBN, try again.";

    const result = component.handleScanResult('978-626-414-072-0');

    expect(result).toBe(true);
    expect(component.searchQuery).toBe('9786264140720');
    expect(component.cameraError).toBe('');
    expect(onSearchQueryChangeSpy).toHaveBeenCalled();
    expect(stopScannerSpy).toHaveBeenCalled();

    // Await promise microtask for searchBook invocation
    await Promise.resolve();
    expect(searchBookSpy).toHaveBeenCalled();
  });

  it('offers "scan again" after a scanned search, not after a typed one', () => {
    vi.spyOn(component, 'stopScanner').mockResolvedValue();
    vi.spyOn(component, 'searchBook').mockImplementation(() => {});

    component.handleScanResult('9786264140720');
    expect(component.lastSearchWasScan).toBe(true);

    component.searchQuery = '97862641407';
    component.onSearchQueryChange();
    expect(component.lastSearchWasScan).toBe(false);
  });

  it('rescan clears the scanned ISBN and its results, then reopens the camera', async () => {
    const startScannerSpy = vi.spyOn(component, 'startScanner').mockResolvedValue();
    component.searchQuery = '9786264140720';
    component.searchResults = [{ title: 'A book' }];
    component.lastSearchWasScan = true;

    await component.rescan();

    expect(component.searchQuery).toBe('');
    expect(component.searchResults).toEqual([]);
    expect(component.bookPreview).toBeNull();
    expect(component.lastSearchWasScan).toBe(false);
    expect(startScannerSpy).toHaveBeenCalled();
  });

  it('hides the manual-entry fields once the ISBN query is edited', () => {
    component.enterManually();
    expect(component.bookPreview?.isManual).toBe(true);

    component.searchQuery = '978626414072';
    component.onSearchQueryChange();

    expect(component.bookPreview).toBeNull();
    expect(component.canSearch).toBe(true);
  });

  it('keeps a picked (non-manual) book when the query is edited', () => {
    component.selectBook({ title: 'A book', author: 'Someone' });
    component.onSearchQueryChange();
    expect(component.bookPreview?.title).toBe('A book');
  });

  it('should accept valid ISBN-10 scan with check digit X', async () => {
    const stopScannerSpy = vi.spyOn(component, 'stopScanner').mockResolvedValue();
    const searchBookSpy = vi.spyOn(component, 'searchBook').mockImplementation(() => {});

    const result = component.handleScanResult('0-0000-0006-x');

    expect(result).toBe(true);
    expect(component.searchQuery).toBe('000000006X');
    expect(component.cameraError).toBe('');
    expect(stopScannerSpy).toHaveBeenCalled();

    await Promise.resolve();
    expect(searchBookSpy).toHaveBeenCalled();
  });

  it('should reject a correctly-shaped but checksum-invalid scan (garbled misread)', () => {
    const stopScannerSpy = vi.spyOn(component, 'stopScanner');
    const searchBookSpy = vi.spyOn(component, 'searchBook');

    component.searchQuery = '';

    // 13 digits, passes the format check, but the check digit is wrong —
    // the shape a camera misread often produces.
    const result = component.handleScanResult('9786264140721');

    expect(result).toBe(false);
    expect(component.searchQuery).toBe('');
    expect(stopScannerSpy).not.toHaveBeenCalled();
    expect(searchBookSpy).not.toHaveBeenCalled();
    expect(component.cameraError).toBe("Scanned code doesn't look like a valid ISBN, try again.");
  });

  it('should reject non-ISBN scan, keep scanner running, and set cameraError', () => {
    const stopScannerSpy = vi.spyOn(component, 'stopScanner');
    const searchBookSpy = vi.spyOn(component, 'searchBook');

    component.searchQuery = '';
    component.isScanning = true;

    const result = component.handleScanResult('https://example.com/qr-code');

    expect(result).toBe(false);
    expect(component.searchQuery).toBe('');
    expect(stopScannerSpy).not.toHaveBeenCalled();
    expect(searchBookSpy).not.toHaveBeenCalled();
    expect(component.cameraError).toBe("Scanned code doesn't look like a valid ISBN, try again.");
    expect(mockI18n.t).toHaveBeenCalledWith('sell.invalidBarcodeScanned');
  });

  it('should not repeatedly trigger change detection on consecutive identical invalid scans', () => {
    const cdrSpy = vi.spyOn((component as any).cdr, 'markForCheck');

    component.handleScanResult('https://example.com/qr-code');
    const firstCallCount = cdrSpy.mock.calls.length;

    // Second invalid scan with same resulting error message
    component.handleScanResult('123');
    const secondCallCount = cdrSpy.mock.calls.length;

    expect(secondCallCount).toBe(firstCallCount);
  });

  it('should clear invalidBarcodeScanned cameraError when stopScanner is called', async () => {
    component.cameraError = "Scanned code doesn't look like a valid ISBN, try again.";
    component.isScanning = true;

    await component.stopScanner();

    expect(component.cameraError).toBe('');
    expect(component.isScanning).toBe(false);
  });

  it('blocks second scan while first scan is already processing', () => {
    component.isScanning = true;
    (component as any).isProcessingScan = true;

    const result = component.handleScanResult('9786264140720');
    expect(result).toBe(false);
    expect(component.searchQuery).toBe('');
  });

  it('should clear cameraError when succeeding after a previous invalid scan', async () => {
    vi.spyOn(component, 'stopScanner').mockResolvedValue();
    vi.spyOn(component, 'searchBook').mockImplementation(() => {});

    // First scan is invalid
    component.handleScanResult('invalid-qr');
    expect(component.cameraError).toBe("Scanned code doesn't look like a valid ISBN, try again.");

    // Second scan is valid
    component.handleScanResult('9786264140720');
    expect(component.cameraError).toBe('');
    expect(component.searchQuery).toBe('9786264140720');
  });

  it('shows the sign-in state when the session ends while the page is open', () => {
    expect(component.isLoggedIn).toBe(true);

    // The session dies in the background: nothing navigates, the store flips.
    (TestBed.inject(AuthStore) as any).isLoggedIn = () => false;

    expect(component.isLoggedIn).toBe(false);
  });
});

describe('Sell listing form guarding, drafts and field validation', () => {
  let fixture: ComponentFixture<Sell>;
  let component: Sell;

  const mockI18n = {
    t: vi.fn((key: string) => key),
    lang: () => 'en'
  };

  /** Builds a fixture on demand so a test can seed localStorage first. */
  const create = () => {
    fixture = TestBed.createComponent(Sell);
    component = fixture.componentInstance;
    fixture.detectChanges();
    return component;
  };

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [Sell, HttpClientTestingModule],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0, symbol: 'NT$' }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        provideRouter([]),
        {
          provide: BookService,
          useValue: {
            getEngineOptions: vi.fn().mockReturnValue([{ label: 'Google Books', value: 'googlebooks' }]),
            searchBooks: vi.fn().mockReturnValue(of({ results: [] })),
            getBook: vi.fn().mockReturnValue(of({ price_stats: { count: 0, min: null, max: null } })),
            createManualBook: vi.fn().mockReturnValue(of({ id: 'book-1' }))
          }
        },
        { provide: I18nService, useValue: mockI18n },
        { provide: AuthStore, useValue: { isLoggedIn: () => true, user: () => ({ id: 'user-1' }), isVerifiedIn: () => true } },
        { provide: AccountService, useValue: { getMyProfile: vi.fn().mockReturnValue(of({ verified_at: '2026-01-01' })) } },
        { provide: ListingService, useValue: { uploadPhoto: vi.fn(), deletePhoto: vi.fn().mockReturnValue(of({})), createListing: vi.fn() } },
        { provide: MetadataService, useValue: { getMetadata: vi.fn().mockReturnValue(of({ categories: [{ title: 'Engineering', slug: 'engineering' }] })), getMetadataWithRetry: vi.fn().mockReturnValue(of({ categories: [{ title: 'Engineering', slug: 'engineering' }] })) } },
        { provide: GoogleAnalyticsService, useValue: { trackEvent: vi.fn(), trackPublishListing: vi.fn() } }
      ]
    }).compileComponents();
  });

  afterEach(() => {
    component?.ngOnDestroy();
    localStorage.clear();
  });

  describe('category metadata', () => {
    it('handles a failure to load categories instead of leaving it uncaught', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const metadata = TestBed.inject(MetadataService) as any;
      metadata.getMetadataWithRetry.mockReturnValue(throwError(() => new Error('down')));

      expect(() => create()).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith('Failed to load categories', expect.any(Error));
    });

    it('stops waiting on categories when the page is left', () => {
      const pending = new Subject<any>();
      (TestBed.inject(MetadataService) as any).getMetadataWithRetry.mockReturnValue(pending);
      create();
      expect(pending.observed).toBe(true);

      component.ngOnDestroy();

      expect(pending.observed).toBe(false);
    });
  });

  describe('search on Enter', () => {
    const searchField = () => fixture.nativeElement.querySelector('ui-input input') as HTMLInputElement;
    const type = (value: string) => {
      const input = searchField();
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const pressEnter = (init: KeyboardEventInit = {}) =>
      searchField().dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, ...init }));

    it('searches when Enter is pressed in the ISBN field', () => {
      create();
      const books = TestBed.inject(BookService) as any;
      type('9786264140720');
      pressEnter();
      expect(books.searchBooks).toHaveBeenCalledTimes(1);
      expect(books.searchBooks.mock.calls[0][0]).toBe('9786264140720');
    });

    it('does not search on an empty field', () => {
      create();
      pressEnter();
      expect((TestBed.inject(BookService) as any).searchBooks).not.toHaveBeenCalled();
    });

    it('ignores the Enter that confirms an IME candidate', () => {
      vi.useFakeTimers();
      try {
        create();
        const books = TestBed.inject(BookService) as any;
        type('微積分');
        const input = searchField();

        // Mid-composition, and the keyup that lands in the same tick as
        // compositionend (isComposing already false in some browsers).
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        pressEnter({ isComposing: true });
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        pressEnter();
        expect(books.searchBooks).not.toHaveBeenCalled();

        // A deliberate Enter afterwards does search.
        vi.runAllTimers();
        pressEnter();
        expect(books.searchBooks).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-search (and drop the picked book) when the search button is hidden', () => {
      create();
      component.searchQuery = '9786264140720';
      component.selectBook({ id: 'b1', title: 'Clean Code', author: 'Robert C. Martin' });
      component.onSearchEnter(new KeyboardEvent('keyup', { key: 'Enter' }));
      expect((TestBed.inject(BookService) as any).searchBooks).not.toHaveBeenCalled();
      expect(component.bookPreview?.id).toBe('b1');
    });

    it('does not start a second search while one is running', () => {
      create();
      component.searchQuery = '9786264140720';
      component.isCheckingIsbn = true;
      component.onSearchEnter(new KeyboardEvent('keyup', { key: 'Enter' }));
      expect((TestBed.inject(BookService) as any).searchBooks).not.toHaveBeenCalled();
    });

    it('handles 504 gateway timeout without switching to manual entry', () => {
      create();
      const books = TestBed.inject(BookService) as any;
      books.searchBooks.mockReturnValue(throwError(() => ({ status: 504 })));

      component.searchQuery = '9789863126942';
      component.searchBook();

      expect(component.isCheckingIsbn).toBe(false);
      expect(component.apiError).toBe('sell.upstreamTimeout');
      expect(component.bookPreview).toBeNull();
      expect(component.canSearch).toBe(true);
    });

    it('handles 200 empty results by prompting manual entry', () => {
      create();
      const books = TestBed.inject(BookService) as any;
      books.searchBooks.mockReturnValue(of({ results: [] }));

      component.searchQuery = '9789863126942';
      component.searchBook();

      expect(component.isCheckingIsbn).toBe(false);
      expect(component.apiError).toBe('sell.notFoundIsbn');
      expect(component.bookPreview?.isManual).toBe(true);
    });
  });

  describe('pricing step reference, warning and summary', () => {
    const books = () => TestBed.inject(BookService) as any;
    const render = () => {
      (component as any).cdr.markForCheck();
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    };
    const toPricing = (book: any) => {
      component.selectBook(book);
      component.nextStep();
      component.nextStep();
      expect(component.step).toBe(3);
    };

    it('looks up the copies already listed once the price step is reached', () => {
      create();
      books().getBook.mockReturnValue(of({ price_stats: { count: 2, min: 100, max: 10099 } }));

      toPricing({ id: 42, title: 'Clean Code', author: 'Robert C. Martin' });

      expect(books().getBook).toHaveBeenCalledWith('42');
      expect(component.otherCopies).toEqual({ count: 2, min: 100, max: 10099 });
      const reference = render().querySelector('.price-reference');
      expect(reference?.textContent?.trim()).toBe('sell.otherCopiesRange');
    });

    it('does not look up again when returning to the step for the same book', () => {
      create();
      toPricing({ id: 42, title: 'Clean Code' });
      component.prevStep();
      component.nextStep();
      expect(books().getBook).toHaveBeenCalledTimes(1);
    });

    it('shows no reference for a book that is not in the catalogue yet', () => {
      create();
      component.enterManually();
      component.bookPreview.title = 'Handout';
      component.bookPreview.authors = 'Dept.';
      component.nextStep();
      component.nextStep();

      expect(books().getBook).not.toHaveBeenCalled();
      expect(component.otherCopies).toBeNull();
      expect(render().querySelector('.price-reference')).toBeNull();
    });

    it('leaves the reference out when the lookup fails', () => {
      create();
      books().getBook.mockReturnValue(throwError(() => new Error('down')));
      toPricing({ id: 42, title: 'Clean Code' });
      expect(component.otherCopies).toBeNull();
    });

    it('warns about a price far above the cheapest copy but still submits it unchanged', () => {
      create();
      const listingService = TestBed.inject(ListingService) as any;
      listingService.createListing.mockReturnValue(of({}));
      component.isVerified = true;
      books().getBook.mockReturnValue(of({ price_stats: { count: 2, min: 100, max: 10099 } }));
      toPricing({ id: 42, title: 'Clean Code' });

      component.price = 300;
      expect(component.priceWarning).toBe(false);
      component.price = 3000;
      expect(component.priceWarning).toBe(true);
      expect(render().querySelector('.inline-msg.warn')?.textContent?.trim()).toBe('sell.priceFarAbove');

      component.submit();
      expect(listingService.createListing).toHaveBeenCalledWith(expect.objectContaining({ book: 42, price: 3000 }));
      expect(component.step).toBe(4);
    });

    it.each([
      ['a misread that is no ISBN', '6770250629200', ''],
      ['a wrong check digit', '9789860629201', ''],
      ['a real ISBN, cleaned', '978-986-06-2920-0', '9789860629200'],
    ])('files a hand-entered book under the typed ISBN only when it is one (%s)', (_, typed, expected) => {
      create();
      (TestBed.inject(ListingService) as any).createListing.mockReturnValue(of({}));
      component.isVerified = true;
      component.searchQuery = typed;
      component.enterManually();
      component.bookPreview.title = 'Handout';
      component.bookPreview.authors = 'Dept.';
      component.nextStep();
      component.nextStep();
      component.price = 100;

      component.submit();

      expect(books().createManualBook).toHaveBeenCalledWith(expect.objectContaining({ isbn13: expected }));
    });

    it('summarises the title, condition, price and photo count above Confirm Listing', () => {
      create();
      toPricing({ id: 42, title: 'Clean Code' });
      component.condition = 'like_new';
      component.uploadedPhotos = ['https://cdn.example/a.jpg', 'https://cdn.example/gone.jpg'];
      component.onPhotoError('https://cdn.example/gone.jpg');
      component.setFree();

      const values = Array.from(render().querySelectorAll('.listing-summary dd')).map(dd => dd.textContent?.trim());
      // Only the photo that will actually be submitted is counted.
      expect(values).toEqual(['Clean Code', 'cond.like_new', 'sell.summaryFree', '1']);
    });
  });

  describe('photo selection', () => {
    const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
    const listings = () => TestBed.inject(ListingService) as any;

    it('lets the file picker select several photos at once', () => {
      create();
      component.step = 2;
      (component as any).cdr.markForCheck();
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input.multiple).toBe(true);
    });

    it('takes the buyer-visible description in a multi-line field', () => {
      create();
      component.step = 2;
      (component as any).cdr.markForCheck();
      fixture.detectChanges();
      const textarea = fixture.nativeElement.querySelector('ui-textarea textarea') as HTMLTextAreaElement;
      expect(textarea).not.toBeNull();

      textarea.value = 'Clean pages.\nMinor highlighting in chapter 1.';
      textarea.dispatchEvent(new Event('input'));
      expect(component.description).toBe('Clean pages.\nMinor highlighting in chapter 1.');
    });

    it('uploads every picked photo, in the order picked', () => {
      create();
      listings().uploadPhoto.mockImplementation((f: File) => of({ url: `https://cdn.example/${f.name}` }));

      component.onFileSelected({ target: { files: [file('a.jpg'), file('b.jpg')], value: 'x' } });

      expect(component.uploadedPhotos).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
      expect(component.uploadError).toBe('');
      expect(component.isUploading).toBe(false);
    });

    it('caps a listing at five photos', () => {
      // The label copy (sell.photoLabel) promises five, and the edit dialog in
      // account/listings.ts shares this constant.
      expect(SELL_MAX_PHOTOS).toBe(5);
      create();
      expect(component.maxPhotos).toBe(5);
    });

    it('uploads only as many as fit under the cap and says the rest were left out', () => {
      create();
      component.uploadedPhotos = ['https://cdn.example/existing.jpg'];
      listings().uploadPhoto.mockImplementation((f: File) => of({ url: `https://cdn.example/${f.name}` }));

      // One already there leaves room for four of these six.
      const names = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg'];
      component.onFileSelected({ target: { files: names.map(file), value: 'x' } });

      expect(listings().uploadPhoto).toHaveBeenCalledTimes(SELL_MAX_PHOTOS - 1);
      expect(component.uploadedPhotos).toEqual([
        'https://cdn.example/existing.jpg',
        ...names.slice(0, SELL_MAX_PHOTOS - 1).map(n => `https://cdn.example/${n}`),
      ]);
      expect(component.uploadError).toBe('sell.photoLimitReached');
    });

    it('shows the drop zone until the cap is reached, then hides it', () => {
      create();
      component.step = 2;
      component.uploadedPhotos = Array.from({ length: SELL_MAX_PHOTOS - 1 }, (_, i) => `https://cdn.example/${i}.jpg`);
      (component as any).cdr.markForCheck();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.dropzone')).not.toBeNull();

      component.uploadedPhotos = [...component.uploadedPhotos, 'https://cdn.example/last.jpg'];
      (component as any).cdr.markForCheck();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.preview-box').length).toBe(SELL_MAX_PHOTOS);
      expect(fixture.nativeElement.querySelector('.dropzone')).toBeNull();
    });

    it('counts photos still uploading against the cap', () => {
      create();
      const uploads = new Map<string, Subject<{ url: string }>>();
      listings().uploadPhoto.mockImplementation((f: File) => {
        const upload = new Subject<{ url: string }>();
        uploads.set(f.name, upload);
        return upload;
      });
      const finish = (name: string) => {
        uploads.get(name)!.next({ url: `https://cdn.example/${name}` });
        uploads.get(name)!.complete();
      };

      component.handleFiles([file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')]);
      expect(component.isUploading).toBe(true);

      // A drop while those four are on their way has room for one more only.
      component.handleFiles([file('e.jpg'), file('f.jpg')]);
      expect(component.uploadError).toBe('sell.photoLimitReached');

      ['a.jpg', 'e.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].forEach(finish);
      expect(uploads.has('f.jpg')).toBe(false);
      expect(component.uploadedPhotos.length).toBe(SELL_MAX_PHOTOS);
      expect(component.isUploading).toBe(false);
    });

    it('keeps uploading the rest of a batch when one photo fails', () => {
      create();
      listings().uploadPhoto.mockImplementation((f: File) =>
        f.name === 'bad.jpg' ? throwError(() => new Error('boom')) : of({ url: `https://cdn.example/${f.name}` }));

      component.handleFiles([file('bad.jpg'), file('good.jpg')]);

      expect(component.uploadedPhotos).toEqual(['https://cdn.example/good.jpg']);
      expect(component.uploadError).toBe('sell.uploadFailed');
      expect(component.isUploading).toBe(false);
    });

    it('takes every photo dropped on the drop zone, not just the first', () => {
      create();
      listings().uploadPhoto.mockImplementation((f: File) => of({ url: `https://cdn.example/${f.name}` }));
      const event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [file('a.jpg'), file('b.jpg')] } } as any;

      component.onDrop(event);

      expect(component.uploadedPhotos.length).toBe(2);
    });
  });

  describe('hasUnsavedChanges', () => {
    it('does not intercept an untouched step 1', () => {
      create();
      expect(component.step).toBe(1);
      expect(component.hasUnsavedChanges()).toBe(false);
    });

    it('does not intercept a typed-but-unselected ISBN', () => {
      create();
      component.searchQuery = '9786264140720';
      component.onSearchQueryChange();
      expect(component.hasUnsavedChanges()).toBe(false);
    });

    it('does not intercept manual entry that is still completely blank', () => {
      create();
      component.enterManually();
      expect(component.hasUnsavedChanges()).toBe(false);
    });

    it('intercepts once a book has been selected', () => {
      create();
      component.selectBook({ id: 'b1', title: 'Clean Code', author: 'Robert C. Martin' });
      expect(component.hasUnsavedChanges()).toBe(true);
    });

    it('intercepts once manual entry has any content', () => {
      create();
      component.enterManually();
      component.bookPreview.title = 'Untitled draft';
      expect(component.hasUnsavedChanges()).toBe(true);
    });

    it('intercepts on step 2 details and uploaded photos', () => {
      create();
      component.course = 'CS101';
      expect(component.hasUnsavedChanges()).toBe(true);

      component.course = '';
      component.uploadedPhotos = ['https://cdn.example/photo.jpg'];
      expect(component.hasUnsavedChanges()).toBe(true);
    });

    it('intercepts once a price has been entered, free included', () => {
      create();
      component.setFree();
      expect(component.price).toBe(0);
      expect(component.hasUnsavedChanges()).toBe(true);
    });

    it('does not intercept the success screen even with a full form', () => {
      create();
      component.selectBook({ id: 'b1', title: 'Clean Code' });
      component.course = 'CS101';
      component.price = 300;
      component.step = 4;
      expect(component.hasUnsavedChanges()).toBe(false);
    });

    it('tells the seller where to edit or take down the listing after publishing', () => {
      create();
      component.step = 4;
      (component as any).cdr.markForCheck();
      fixture.detectChanges();

      const hint = fixture.nativeElement.querySelector('.success-manage-hint') as HTMLElement;
      expect(hint).not.toBeNull();
      expect(hint.textContent).toContain('sell.successManageHint');
      const link = hint.querySelector('a') as HTMLAnchorElement;
      // Named with the same keys as the account menu it points at.
      expect(link.textContent?.trim()).toBe('nav.account → acct.tabListings');
      // Region-prefixed, like every other in-app link.
      expect(link.getAttribute('href')).toBe('/tw/account/listings');
    });

    it('uses the sell.leaveConfirm key for the confirmation message', () => {
      create();
      expect(component.unsavedChangesMessage()).toBe('sell.leaveConfirm');
      expect(mockI18n.t).toHaveBeenCalledWith('sell.leaveConfirm');
    });
  });

  describe('draft persistence', () => {
    it('stores nothing for an empty form', () => {
      create();
      component.saveDraft();
      expect(localStorage.getItem(SELL_DRAFT_STORAGE_KEY)).toBeNull();
    });

    it('stores the form state once there is something to keep', () => {
      create();
      component.selectBook({ id: 'b1', title: 'Clean Code', author: 'Robert C. Martin' });
      component.course = 'CS101';
      component.professor = 'Chen';
      component.uploadedPhotos = ['https://cdn.example/photo.jpg'];
      component.price = 250;
      component.step = 3;
      component.saveDraft();

      const stored = JSON.parse(localStorage.getItem(SELL_DRAFT_STORAGE_KEY)!);
      expect(stored.step).toBe(3);
      expect(stored.course).toBe('CS101');
      expect(stored.professor).toBe('Chen');
      expect(stored.price).toBe(250);
      expect(stored.uploadedPhotos).toEqual(['https://cdn.example/photo.jpg']);
      expect(stored.bookPreview.title).toBe('Clean Code');
    });

    it('offers a found draft instead of restoring it silently', () => {
      localStorage.setItem(SELL_DRAFT_STORAGE_KEY, JSON.stringify({
        version: 1, savedAt: Date.now(), step: 2, searchQuery: '',
        bookPreview: { title: 'Clean Code', authors: 'Robert C. Martin', isManual: false },
        condition: 'like_new', category: 'engineering', course: 'CS101', professor: 'Chen',
        privateNote: '', description: '', price: 250, uploadedPhotos: ['https://cdn.example/photo.jpg']
      }));

      create();
      expect(component.showDraftPrompt).toBe(true);
      // Nothing applied until the user chooses.
      expect(component.course).toBe('');
      expect(component.step).toBe(1);

      component.resumeDraft();
      expect(component.showDraftPrompt).toBe(false);
      expect(component.step).toBe(2);
      expect(component.course).toBe('CS101');
      expect(component.condition).toBe('like_new');
      expect(component.category).toBe('engineering');
      expect(component.price).toBe(250);
      expect(component.uploadedPhotos).toEqual(['https://cdn.example/photo.jpg']);
    });

    it('drops a category that no longer exists in this region', () => {
      localStorage.setItem(SELL_DRAFT_STORAGE_KEY, JSON.stringify({
        version: 1, savedAt: Date.now(), step: 2, searchQuery: '',
        bookPreview: null, condition: 'new', category: 'retired-slug', course: 'CS101',
        professor: '', privateNote: '', description: '', price: null, uploadedPhotos: []
      }));

      create();
      component.resumeDraft();
      expect(component.category).toBe('');
      expect(component.course).toBe('CS101');
    });

    it('discards the draft on "start over"', () => {
      localStorage.setItem(SELL_DRAFT_STORAGE_KEY, JSON.stringify({
        version: 1, savedAt: Date.now(), step: 2, searchQuery: '',
        bookPreview: null, condition: 'new', category: '', course: 'CS101',
        professor: '', privateNote: '', description: '', price: null, uploadedPhotos: []
      }));

      create();
      component.discardDraft();
      expect(component.showDraftPrompt).toBe(false);
      expect(component.course).toBe('');
      expect(localStorage.getItem(SELL_DRAFT_STORAGE_KEY)).toBeNull();
    });

    it('ignores and clears an expired draft', () => {
      localStorage.setItem(SELL_DRAFT_STORAGE_KEY, JSON.stringify({
        version: 1, savedAt: Date.now() - SELL_DRAFT_MAX_AGE_MS - 1000, step: 2,
        searchQuery: '', bookPreview: null, condition: 'new',
        category: '', course: 'CS101', professor: '', privateNote: '', description: '',
        price: null, uploadedPhotos: []
      }));

      create();
      expect(component.showDraftPrompt).toBe(false);
      expect(localStorage.getItem(SELL_DRAFT_STORAGE_KEY)).toBeNull();
    });

    it('ignores and clears unparseable draft data', () => {
      localStorage.setItem(SELL_DRAFT_STORAGE_KEY, 'not json');
      create();
      expect(component.showDraftPrompt).toBe(false);
      expect(localStorage.getItem(SELL_DRAFT_STORAGE_KEY)).toBeNull();
    });

    it('treats typing into a fresh form as an implicit "start over"', () => {
      localStorage.setItem(SELL_DRAFT_STORAGE_KEY, JSON.stringify({
        version: 1, savedAt: Date.now(), step: 2, searchQuery: '',
        bookPreview: null, condition: 'new', category: '', course: 'Old course',
        professor: '', privateNote: '', description: '', price: null, uploadedPhotos: []
      }));

      create();
      expect(component.showDraftPrompt).toBe(true);

      component.course = 'New course';
      component.onFormChange();

      expect(component.showDraftPrompt).toBe(false);
      expect(JSON.parse(localStorage.getItem(SELL_DRAFT_STORAGE_KEY)!).course).toBe('New course');
    });

    it('marks a photo broken rather than breaking the layout, and drops it from the payload', () => {
      create();
      component.uploadedPhotos = ['https://cdn.example/gone.jpg', 'https://cdn.example/ok.jpg'];
      component.onPhotoError('https://cdn.example/gone.jpg');

      expect(component.isPhotoBroken('https://cdn.example/gone.jpg')).toBe(true);
      expect(component.isPhotoBroken('https://cdn.example/ok.jpg')).toBe(false);
      expect(component.uploadedPhotos.length).toBe(2);
    });
  });

  describe('inline field validation', () => {
    it('stays quiet until the field is touched or the step is attempted', () => {
      create();
      component.enterManually();
      expect(component.titleErrorKey).toBe('');
      expect(component.authorErrorKey).toBe('');

      component.markTouched('title');
      expect(component.titleErrorKey).toBe('sell.errTitleRequired');
      expect(component.authorErrorKey).toBe('');
    });

    it('blocks step 1 and reveals both messages when the manual fields are empty', () => {
      create();
      component.enterManually();
      component.nextStep();

      expect(component.step).toBe(1);
      expect(component.titleErrorKey).toBe('sell.errTitleRequired');
      expect(component.authorErrorKey).toBe('sell.errAuthorRequired');
    });

    it('clears the messages and advances once the manual fields are filled', () => {
      create();
      component.enterManually();
      component.nextStep();
      component.bookPreview.title = 'Clean Code';
      component.bookPreview.authors = 'Robert C. Martin';

      expect(component.titleErrorKey).toBe('');
      expect(component.authorErrorKey).toBe('');

      component.nextStep();
      expect(component.step).toBe(2);
    });

    it('does not validate title/author for a book picked from search results', () => {
      create();
      component.selectBook({ id: 'b1', title: 'Clean Code', author: 'Robert C. Martin' });
      component.nextStep();
      expect(component.step).toBe(2);
      expect(component.titleErrorKey).toBe('');
    });

    it('reports an empty price as required and a negative price as invalid', () => {
      create();
      component.step = 3;
      expect(component.priceErrorKey).toBe('');

      component.markTouched('price');
      expect(component.priceErrorKey).toBe('sell.errPriceRequired');

      component.price = -5;
      expect(component.priceErrorKey).toBe('sell.errPriceInvalid');
    });

    it('accepts free (0) as a valid price', () => {
      create();
      component.step = 3;
      component.markTouched('price');
      component.setFree();
      expect(component.price).toBe(0);
      expect(component.priceErrorKey).toBe('');
    });
  });
});
