import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BookService, engineForSource, parseSearchEngine } from './book.service';

/**
 * The search and sell pages used to send engine=googlebooks on every request,
 * which is the one value that switches the backend's fallback chain off: a
 * book Google had no record of came back as "not found" without the ISBN
 * registry or Open Library ever being asked.
 */
describe('BookService.searchBooks engine parameter', () => {
  let service: BookService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(BookService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('leaves engine out when none was asked for, so the backend falls back', () => {
    service.searchBooks('9789863126942').subscribe();
    service.searchBooks('calculus', '', '', '', 1, null).subscribe();

    const urls = http.match(() => true).map(req => req.request.urlWithParams);
    expect(urls).toHaveLength(2);
    urls.forEach(url => expect(url).not.toContain('engine='));
  });

  it('sends engine when a specific catalogue was asked for', () => {
    service.searchBooks('9789863126942', '', '', '', 1, 'isbnnet').subscribe();

    const req = http.expectOne(r => r.urlWithParams.includes('engine=isbnnet'));
    req.flush([]);
  });

  it('sends the listing filters, so the backend filters before paging', () => {
    service.searchBooks('', '', '', '', 1, null, { condition: 'damaged', price_min: '100' }).subscribe();

    const req = http.expectOne(r => r.urlWithParams.includes('condition=damaged') && r.urlWithParams.includes('price_min=100'));
    req.flush([]);
  });
});

/**
 * The API has no trailing slashes; the book page asked for `/books/?isbn=…`,
 * which matched no route and showed every book as "not found".
 */
describe('BookService.getBook', () => {
  let service: BookService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(BookService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks for a book by ISBN without a trailing slash', () => {
    service.getBook('9789865027803', 1, 'CHIHLEE').subscribe();

    http.expectOne('/books?isbn=9789865027803&page=1&school=CHIHLEE').flush({});
  });

  it('names the Google volume a search-result link carries', () => {
    service.getBook('9783819246562', 1, undefined, 'googlebooks', 'L4FdEQAAQBAJ').subscribe();

    http.expectOne('/books?isbn=9783819246562&page=1&engine=googlebooks&gid=L4FdEQAAQBAJ').flush({});
  });

  it('asks for a book by id without a trailing slash', () => {
    service.getBook('ab7493f8-19bb-4fe4-8dc7-dbccf09c91a0').subscribe();

    http.expectOne('/books?id=ab7493f8-19bb-4fe4-8dc7-dbccf09c91a0&page=1').flush({});
  });
});

describe('search engine helpers', () => {
  it('maps a result source to the engine that produced it', () => {
    expect(engineForSource('google_api')).toBe('googlebooks');
    expect(engineForSource('openlibrary_api')).toBe('openlibrary');
    expect(engineForSource('isbnnet_api')).toBe('isbnnet');
  });

  it('gives no engine for a book already in the catalogue', () => {
    expect(engineForSource('manual')).toBeNull();
    expect(engineForSource(undefined)).toBeNull();
  });

  it('accepts only known engines from a URL', () => {
    expect(parseSearchEngine('isbnnet')).toBe('isbnnet');
    expect(parseSearchEngine('googlebooks')).toBe('googlebooks');
    expect(parseSearchEngine('bing')).toBeNull();
    expect(parseSearchEngine(null)).toBeNull();
  });
});
