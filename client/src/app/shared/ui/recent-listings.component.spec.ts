import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { UiRecentListings, RECENT_BOOKS_PAGE_SIZE } from './recent-listings.component';
import { ListingService } from '../../core/services/listing.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { hasBookPreviewState } from '../../core/book-preview';
import { SchoolStateService } from '../../core/services/school-state.service';

@Component({ template: '' })
class Blank {}

describe('UiRecentListings', () => {
  let listingService: { getRecentBooks: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    listingService = {
      getRecentBooks: vi.fn().mockReturnValue(of({
        count: 2,
        results: [
          { id: 2, isbn: '9781449319793', title: 'Python for Data Analysis', authors: 'Wes McKinney', conditions: { new: 2 }, min_price: 100 },
          { id: 5, isbn: '', title: 'No ISBN', authors: '', conditions: { good: 1 }, min_price: 50 },
        ],
      })),
    };
    TestBed.configureTestingModule({
      imports: [UiRecentListings],
      providers: [
        provideRouter([{ path: 'tw/book', component: Blank }]),
        { provide: ListingService, useValue: listingService },
        { provide: I18nService, useValue: { lang: () => 'en', t: (key: string) => key } },
        { provide: RegionService, useValue: { region: () => 'tw', currency: () => ({ code: 'TWD', decimal_places: 0 }), regions: () => [] } },
      ],
    });
  });

  /** Renders, then lets the coalesced (debounceTime(0)) fetch land. */
  async function render() {
    const fixture = TestBed.createComponent(UiRecentListings);
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve));
    fixture.detectChanges();
    return fixture;
  }

  it('asks the backend for one page of the size it paginates by', async () => {
    await render();
    expect(RECENT_BOOKS_PAGE_SIZE).toBe(20);
    for (const call of listingService.getRecentBooks.mock.calls) {
      expect(call[2]).toBe(20);
    }
    expect(listingService.getRecentBooks).toHaveBeenCalled();
  });

  it('links each book by isbn or id, with no internal flag in the href', async () => {
    const fixture = await render();
    const hrefs = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('a.tile-body'),
      a => a.getAttribute('href'),
    );
    expect(hrefs).toEqual(['/tw/book?isbn=9781449319793', '/tw/book?id=5']);
  });

  it('still lets the book page use the preview it primes, through router state', async () => {
    const fixture = await render();
    const router = TestBed.inject(Router);
    const anchor = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a.tile-body')!;

    anchor.click();
    await fixture.whenStable();

    expect(sessionStorage.getItem('cachedBook_9781449319793')).toContain('Python for Data Analysis');
    expect(router.url).toBe('/tw/book?isbn=9781449319793');
    expect(hasBookPreviewState(router.lastSuccessfulNavigation()?.extras.state)).toBe(true);
    sessionStorage.removeItem('cachedBook_9781449319793');
  });
  it('keeps the same tiles across change detection, so a failed cover is not re-requested', async () => {
    // gridItems used to build new wrapper objects on every read; *ngFor then
    // re-created every tile on each change detection, and a cover's (error)
    // event — itself a change detection — started the next request.
    listingService.getRecentBooks.mockReturnValue(of({
      count: 1,
      results: [{ id: 9, isbn: '9786263241893', title: 'No cover', authors: '', conditions: { good: 1 }, min_price: 200,
        cover_url: 'https://covers.openlibrary.org/b/isbn/9786263241893-L.jpg' }],
    }));
    const fixture = await render();
    const component = fixture.componentInstance;
    expect(component.gridItems).toBe(component.gridItems);

    const img = fixture.nativeElement.querySelector('ui-book-cover img') as HTMLImageElement;
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    fixture.detectChanges();

    // The placeholder stays, and no new <img> (no new request) appears.
    expect(fixture.nativeElement.querySelector('ui-book-cover img')).toBeNull();
    expect(fixture.nativeElement.querySelector('ui-book-cover .book-placeholder')).not.toBeNull();
  });
  it('makes one request when the school arrives in the same turn it starts', async () => {
    // The school input, the limit input and the language effect each asked
    // for a fetch as the component started; switchMap only cancelled the
    // earlier ones in the browser, after they had reached the backend.
    const fixture = TestBed.createComponent(UiRecentListings);
    fixture.componentRef.setInput('school', 'NTU');
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve));

    expect(listingService.getRecentBooks).toHaveBeenCalledTimes(1);
    expect(listingService.getRecentBooks.mock.calls[0][0]).toBe('NTU');
  });

  describe('when the school has no books', () => {
    beforeEach(() => {
      listingService.getRecentBooks.mockReturnValue(of({
        count: 1, scope: 'city', city: 'TPE',
        results: [{ id: 2, isbn: '9781449319793', title: 'Taipei Calculus', authors: '', conditions: { new: 1 }, min_price: 100 }],
      }));
      const schools = TestBed.inject(SchoolStateService);
      schools.setSchools(
        [{ id: 1, code: 'NTNU', name: 'NTNU', display_name: 'Normal U', city: 'TPE' }],
        [{ code: 'TPE', name: 'Taipei City', display_name: 'Taipei' }],
      );
    });

    async function renderFor(school: string) {
      const fixture = TestBed.createComponent(UiRecentListings);
      fixture.componentRef.setInput('school', school);
      fixture.detectChanges();
      await new Promise(resolve => setTimeout(resolve));
      fixture.detectChanges();
      return fixture;
    }

    it('says the books shown are from the rest of the city', async () => {
      const fixture = await renderFor('NTNU');
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.section-heading')?.textContent).toContain('home.recentTitleCity');
      expect(el.querySelector('.fallback-note')).not.toBeNull();
      expect(fixture.componentInstance.schoolLabel).toBe('Normal U');
      expect(fixture.componentInstance.cityLabel).toBe('Taipei');
    });

    it('offers every university instead, as the header picker would', async () => {
      const fixture = await renderFor('NTNU');
      const schools = TestBed.inject(SchoolStateService);
      const setManual = vi.spyOn(schools, 'setManualSchool');
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.fallback-link')!.click();
      expect(setManual).toHaveBeenCalledWith('');
    });

    it('shows no note when the books are the school\'s own', async () => {
      listingService.getRecentBooks.mockReturnValue(of({ count: 0, scope: 'school', city: 'TPE', results: [] }));
      const fixture = await renderFor('NTNU');
      expect((fixture.nativeElement as HTMLElement).querySelector('.fallback-note')).toBeNull();
    });
  });
});
