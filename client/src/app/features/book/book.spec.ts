import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { Book, BOOK_SOURCE_LABEL_KEYS, bookSourceLabelKey } from './book';
import { BookService } from '../../core/services/book.service';
import { I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { bookPreviewState } from '../../core/book-preview';
import { zhTW } from '../../core/i18n/zh-TW';
import { en } from '../../core/i18n/en';
import { zhHK } from '../../core/i18n/zh-HK';

describe('bookSourceLabelKey', () => {
  it('names every source the backend records', () => {
    expect(bookSourceLabelKey('google_api')).toBe('book.sourceGoogle');
    expect(bookSourceLabelKey('openlibrary_api')).toBe('book.sourceOpenLibrary');
    expect(bookSourceLabelKey('isbnnet_api')).toBe('book.sourceIsbnnet');
    expect(bookSourceLabelKey('manual')).toBe('book.sourceManual');
    expect(bookSourceLabelKey('listed')).toBe('book.sourceListed');
    expect(bookSourceLabelKey('preseed')).toBe('book.sourcePreseed');
  });

  it('has nothing to say for a missing or unknown source', () => {
    expect(bookSourceLabelKey(undefined)).toBeNull();
    expect(bookSourceLabelKey(null)).toBeNull();
    expect(bookSourceLabelKey('')).toBeNull();
    expect(bookSourceLabelKey('amazon_api')).toBeNull();
    // Not fooled by keys every object inherits.
    expect(bookSourceLabelKey('toString')).toBeNull();
  });

  it('points only at keys every language defines', () => {
    for (const key of [...Object.values(BOOK_SOURCE_LABEL_KEYS), 'book.dataSource']) {
      expect(zhTW[key], key).toBeTruthy();
      expect(zhHK[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
  });
});

describe('Book page data source footer', () => {
  let fixture: ComponentFixture<Book>;
  let getBook: ReturnType<typeof vi.fn>;
  let queryParamMap$: BehaviorSubject<any>;

  const i18n = {
    lang: () => 'zh-TW',
    t: (key: string, params?: Record<string, string | number>) => {
      let text = zhTW[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
  };

  const render = (source: unknown) => {
    getBook.mockReturnValue(of({
      id: 'b1', isbn13: '9786264140720', title: '微積分', authors: 'Stewart',
      publisher: '', published_date: '2020', cover_url: '', source,
      listings: { count: 0, results: [] }, waiting_count: 0, is_subscribed: false,
    }));
    fixture = TestBed.createComponent(Book);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(async () => {
    getBook = vi.fn();
    queryParamMap$ = new BehaviorSubject(convertToParamMap({ isbn: '9786264140720' }));
    await TestBed.configureTestingModule({
      imports: [Book, HttpClientTestingModule],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { queryParamMap: queryParamMap$ } },
        { provide: BookService, useValue: { getBook } },
        { provide: I18nService, useValue: i18n },
        { provide: AuthStore, useValue: { isLoggedIn: () => false, isAuthenticated: () => false, user: () => null } },
        { provide: RegionService, useValue: { region: () => 'tw', currency: () => ({ code: 'TWD', decimal_places: 0, symbol: 'NT$' }) } },
        {
          provide: SchoolStateService,
          useValue: { selectedSchool$: of(''), resolvedSchool$: of(''), ready: true, schools$: of([]), getSchoolLabel: (s: string) => s, getSchoolId: () => null },
        },
        { provide: GoogleAnalyticsService, useValue: { trackViewBook: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('names the catalogue the details came from, below everything else', () => {
    const page = render('google_api');
    const footer = page.querySelector('.book-page > .data-source');
    expect(footer?.textContent?.trim()).toBe('書目資料來源：Google Books');
    // The last thing on the page, after the listings section.
    expect(page.querySelector('.book-page')?.lastElementChild).toBe(footer);
  });

  it('describes a user-added book in words, not as a source code', () => {
    expect(render('manual').querySelector('.data-source')?.textContent?.trim()).toBe('書目資料來源：使用者手動新增');
  });

  it('gives books created by a listing or the preset list their own wording', () => {
    expect(render('listed').querySelector('.data-source')?.textContent?.trim()).toBe('書目資料來源：賣家上架時建立');
    fixture.destroy();
    expect(render('preseed').querySelector('.data-source')?.textContent?.trim()).toBe('書目資料來源：平台預建書單');
  });

  it('shows nothing for an unknown or missing source', () => {
    expect(render('amazon_api').querySelector('.data-source')).toBeNull();
    fixture.destroy();
    expect(render(undefined).querySelector('.data-source')).toBeNull();
  });

  describe('opened from a search result', () => {
    const openFromSearch = (stashed: Record<string, unknown>) => {
      sessionStorage.setItem('cachedBook_9786264140720', JSON.stringify({
        isbn: '9786264140720', title: '微積分', author: 'Stewart', ...stashed,
      }));
      const router = TestBed.inject(Router);
      vi.spyOn(router as any, 'lastSuccessfulNavigation', 'get').mockReturnValue((() => ({ extras: { state: bookPreviewState() } })) as any);
      fixture = TestBed.createComponent(Book);
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    };

    afterEach(() => sessionStorage.clear());

    it('keeps naming the catalogue the preview came from when the refresh fails', () => {
      getBook.mockReturnValue(throwError(() => new Error('404')));
      const page = openFromSearch({ source: 'google_api' });
      expect(page.querySelector('.data-source')?.textContent?.trim()).toBe('書目資料來源：Google Books');
    });

    it('does not state a guessed source when the refresh fails', () => {
      getBook.mockReturnValue(throwError(() => new Error('404')));
      expect(openFromSearch({ source: 'manual' }).querySelector('.data-source')).toBeNull();
    });
  });

  describe('mobile infinite scroll', () => {
    it('appends listings on onLoadMore on phones', () => {
      const listing1 = { id: 'l1', price: 100, condition: 'like_new' };
      const listing2 = { id: 'l2', price: 120, condition: 'new' };
      getBook.mockReturnValue(of({
        id: 'b1', isbn13: '9786264140720', title: '微積分', authors: 'Stewart',
        listings: { count: 2, results: [listing1] },
      }));

      fixture = TestBed.createComponent(Book);
      const component = fixture.componentInstance;
      component.isPhone = true;
      fixture.detectChanges();

      expect(component.listings.length).toBe(1);
      expect(component.hasMoreListings).toBe(true);

      getBook.mockReturnValue(of({
        id: 'b1', isbn13: '9786264140720', title: '微積分', authors: 'Stewart',
        listings: { count: 2, results: [listing2] },
      }));

      component.onLoadMore();

      expect(getBook).toHaveBeenCalledWith('9786264140720', 2, '', undefined);
      expect(component.listings.length).toBe(2);
      expect(component.hasMoreListings).toBe(false);
    });

    it('starts at page 1 on phone, ignoring ?page=3', () => {
      queryParamMap$.next(convertToParamMap({ isbn: '9786264140720', page: '3' }));
      getBook.mockReturnValue(of({
        id: 'b1', isbn13: '9786264140720', title: '微積分', authors: 'Stewart',
        listings: { count: 0, results: [] }
      }));

      fixture = TestBed.createComponent(Book);
      const component = fixture.componentInstance;
      component.isPhone = true;
      fixture.detectChanges();

      expect(component.currentPage).toBe(1);
      expect(getBook).toHaveBeenCalledWith('9786264140720', 1, '', undefined);
    });

    it('opens page 3 on desktop when carrying ?page=3', () => {
      queryParamMap$.next(convertToParamMap({ isbn: '9786264140720', page: '3' }));
      getBook.mockReturnValue(of({
        id: 'b1', isbn13: '9786264140720', title: '微積分', authors: 'Stewart',
        listings: { count: 0, results: [] }
      }));

      fixture = TestBed.createComponent(Book);
      const component = fixture.componentInstance;
      component.isPhone = false;
      fixture.detectChanges();

      expect(component.currentPage).toBe(3);
      expect(getBook).toHaveBeenCalledWith('9786264140720', 3, '', undefined);
    });
  });

  // Only a 404 means the book does not exist; a book on screen whose
  // listings failed must not claim nobody is selling it.
  describe('load failures', () => {
    const open = () => {
      fixture = TestBed.createComponent(Book);
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    };

    it('says the book was not found on a 404', () => {
      getBook.mockReturnValue(throwError(() => ({ status: 404 })));
      const page = open();
      expect(page.querySelector('ui-empty')?.textContent).toContain(zhTW['alert.bookNotFound']);
      expect(page.querySelector('ui-error-state')).toBeNull();
    });

    it('offers a retry, not "not found", on any other failure', () => {
      getBook.mockReturnValueOnce(throwError(() => ({ status: 503 })));
      const page = open();
      expect(page.querySelector('ui-error-state')?.textContent).toContain(zhTW['common.loadFailed']);
      expect(page.querySelector('ui-empty')).toBeNull();

      getBook.mockReturnValue(of({
        id: 'b1', isbn13: '9786264140720', title: '微積分', authors: 'Stewart',
        listings: { count: 0, results: [] }, waiting_count: 0,
      }));
      (page.querySelector('ui-error-state button') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(page.querySelector('.book-title')?.textContent).toContain('微積分');
    });

    it('shows a failed listings load under a shown book as failed, not as "none"', () => {
      sessionStorage.setItem('cachedBook_9786264140720', JSON.stringify({ isbn: '9786264140720', title: '微積分', author: 'Stewart' }));
      const router = TestBed.inject(Router);
      vi.spyOn(router as any, 'lastSuccessfulNavigation', 'get').mockReturnValue((() => ({ extras: { state: bookPreviewState() } })) as any);
      getBook.mockReturnValue(throwError(() => ({ status: 503 })));
      const page = open();
      sessionStorage.clear();

      expect(page.querySelector('.book-title')?.textContent).toContain('微積分');
      expect(page.querySelector('.listings-section ui-error-state')?.textContent).toContain(zhTW['book.listingsLoadFailed']);
      expect(page.querySelector('.listings-section ui-empty')).toBeNull();
      expect(page.querySelector('.waitlist-banner')).toBeNull();
    });
  });
});
