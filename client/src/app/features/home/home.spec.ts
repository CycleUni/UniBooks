import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Home } from './home';
import { provideRouter } from '@angular/router';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n.service';
import { ListingService } from '../../core/services/listing.service';
import { MetadataService } from '../../core/services/metadata.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { of } from 'rxjs';
import { Router } from '@angular/router';
import { RegionService } from '../../core/region.service';
import { By } from '@angular/platform-browser';
import { UiSearchField } from '../../shared/ui/search-field.component';


describe('HomeComponent', () => {
  let component: Home;
  let fixture: ComponentFixture<Home>;
  let mockI18n: any;
  let mockListingService: any;
  let mockMetadataService: any;
  let mockSchoolStateService: any;
  let router: Router;

  beforeEach(async () => {
    mockI18n = {
      lang: () => 'zh-TW',
      t: (key: string, params?: Record<string, string | number>) => {
        let text = `Translated: ${key}`;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text += ` (${name}=${value})`;
          }
        }
        return text;
      }
    };

    mockListingService = {
      getListings: vi.fn().mockReturnValue(of([])),
      getRecentBooks: vi.fn().mockReturnValue(of([]))
    };

    mockMetadataService = {
      getMetadata: vi.fn().mockReturnValue(of({
        categories: [{ slug: 'cat1', title: 'Cat 1', desc: 'Cat 1 desc' }],
        waitlist: [{ title: 'Wait 1', count: 5 }]
      })),
      getActiveAds: vi.fn().mockReturnValue(of({ results: [] })),
      recordAdView: vi.fn().mockReturnValue(of({})),
      recordAdClick: vi.fn().mockReturnValue(of({}))
    };

    mockSchoolStateService = {
      selectedSchool$: of('NTU'),
      resolvedSchool$: of('NTU'),
      ready: true,
    };

    await TestBed.configureTestingModule({
      imports: [Home, HttpClientTestingModule],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        provideRouter([]),
        { provide: I18nService, useValue: mockI18n },
        { provide: ListingService, useValue: mockListingService },
        { provide: MetadataService, useValue: mockMetadataService },
        { provide: SchoolStateService, useValue: mockSchoolStateService }
      ]
    }).compileComponents();

    router = TestBed.inject(Router);
    router.navigate = vi.fn();

    fixture = TestBed.createComponent(Home);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  // The metadata endpoint already slices to 7, but the page must not depend
  // on that — this section is a demand signal for sellers, not a directory.
  it('caps the waitlist at seven entries even when the API returns more', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Book ${i}`, count: 20 - i }));
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist: many }));

    component.loadMetadata();

    expect(component.waitlist.length).toBe(7);
    expect(component.waitlist[0].title).toBe('Book 0');
  });

  // Three is a physical limit: HomeHero only defines three fan positions, so a
  // fourth cover would wrap onto the first one's coordinates and vanish.
  it('caps the hero cover stack at three', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Book ${i}`, count: 20 - i }));
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist: many }));

    component.loadMetadata();

    expect(component.heroCovers.length).toBe(3);
  });

  it('should provide trackBy ids correctly', () => {
    expect(component.trackById(0, { id: 10 })).toBe(10);
    expect(component.trackByTitle(0, { title: 'book' })).toBe('book');
  });

  it('leaves hero covers empty when there is no waitlist and no hero ad', () => {
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist: [] }));
    mockMetadataService.getActiveAds.mockReturnValue(of({ results: [] }));

    component.loadAds();
    component.loadMetadata();

    expect(component.heroCovers).toEqual([]);
  });

  it('places a show_in_hero ad at the front of hero covers with waitlist books', () => {
    const heroAd: any = { id: 99, title: 'Ad Title', image_url: 'http://img.png', target_url: 'http://link.com', show_in_hero: true, slot_index: 1 };
    const waitlist = [
      { book_id: 1, title: 'Book 1', cover_url: 'http://b1.png', count: 4 },
      { book_id: 2, title: 'Book 2', cover_url: 'http://b2.png', count: 3 },
      { book_id: 3, title: 'Book 3', cover_url: 'http://b3.png', count: 2 },
    ];
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist }));
    mockMetadataService.getActiveAds.mockReturnValue(of({ results: [heroAd] }));

    component.loadAds();
    component.loadMetadata();

    expect(component.heroCovers.length).toBe(3);
    expect(component.heroCovers[0]).toEqual({
      id: 99,
      title: 'Ad Title',
      coverUrl: 'http://img.png',
      isAd: true,
      targetUrl: 'http://link.com',
      adData: heroAd
    });
    expect(component.heroCovers[1].id).toBe(1);
    expect(component.heroCovers[2].id).toBe(2);
  });

  it('shows the hero ad alone when there is no waitlist', () => {
    const heroAd: any = { id: 99, title: 'Ad Title', image_url: 'http://img.png', target_url: 'http://link.com', show_in_hero: true, slot_index: 1 };
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist: [] }));
    mockMetadataService.getActiveAds.mockReturnValue(of({ results: [heroAd] }));

    component.loadAds();
    component.loadMetadata();

    expect(component.heroCovers.length).toBe(1);
    expect(component.heroCovers[0].isAd).toBe(true);
  });

  it('renders waitlist wcount as-is below 10000 and capped at 9999+ when exceeding 9999', () => {
    const waitlist = [
      { book_id: 1, title: 'Book 1', cover_url: '', count: 50 },
      { book_id: 2, title: 'Book 2', cover_url: '', count: 12000 }
    ];
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist }));

    component.loadMetadata();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const wcounts = compiled.querySelectorAll('.wcount');
    expect(wcounts.length).toBe(2);
    expect(wcounts[0].textContent).toContain('n=50');
    expect(wcounts[1].textContent).toContain('n=9999+');
  });
  it('loads waitlist thumbnails through /api/cover at the same URL as the hero cover', () => {
    // The thumbnails used the raw catalogue URL, so a book in both the hero
    // and the waitlist was fetched twice — once bypassing the proxy.
    const cover = 'https://books.google.com/books/content?id=VXeyEAAAQBAJ&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api';
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist: [
      { book_id: 1, title: 'Book 1', cover_url: cover, count: 9 },
    ] }));
    component.loadMetadata();
    fixture.detectChanges();

    const thumb = fixture.nativeElement.querySelector('.wcover img') as HTMLImageElement;
    const hero = fixture.nativeElement.querySelector('app-home-hero ui-book-cover img') as HTMLImageElement;
    expect(thumb.getAttribute('src')).toMatch(/^\/api\/cover\?src=/);
    expect(thumb.getAttribute('src')).toBe(hero.getAttribute('src'));
  });

  it('marks exactly the waitlist rows the hero stack is already showing', () => {
    const waitlist = [
      { book_id: 1, title: 'Book 1', cover_url: '', count: 9 },
      { book_id: 2, title: 'Book 2', cover_url: '', count: 8 },
      { book_id: 3, title: 'Book 3', cover_url: '', count: 7 },
      { book_id: 4, title: 'Book 4', cover_url: '', count: 6 },
      { book_id: 5, title: 'Book 5', cover_url: '', count: 5 }
    ];
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist }));

    component.loadAds();
    component.loadMetadata();
    fixture.detectChanges();

    expect(component.heroWaitlistCount).toBe(3);
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.waitlist-row');
    expect([...rows].map(r => r.classList.contains('in-hero')))
      .toEqual([true, true, true, false, false]);
    // The rows stay in the DOM: below 769px the hero stack is display: none,
    // so these are the only place those books appear at all.
    expect(rows.length).toBe(5);
  });

  it('counts only two rows as hero-shown when an ad takes a slot in the stack', () => {
    const heroAd: any = { id: 99, title: 'Ad', image_url: 'http://img.png', target_url: 'http://l.com', show_in_hero: true, slot_index: 1 };
    const waitlist = [
      { book_id: 1, title: 'Book 1', cover_url: '', count: 9 },
      { book_id: 2, title: 'Book 2', cover_url: '', count: 8 },
      { book_id: 3, title: 'Book 3', cover_url: '', count: 7 }
    ];
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist }));
    mockMetadataService.getActiveAds.mockReturnValue(of({ results: [heroAd] }));

    component.loadAds();
    component.loadMetadata();
    fixture.detectChanges();

    expect(component.heroWaitlistCount).toBe(2);
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.waitlist-row');
    expect([...rows].map(r => r.classList.contains('in-hero')))
      .toEqual([true, true, false]);
  });

  it('flags the panel as fully covered when the stack has the whole waitlist', () => {
    const waitlist = [
      { book_id: 1, title: 'Book 1', cover_url: '', count: 9 },
      { book_id: 2, title: 'Book 2', cover_url: '', count: 8 }
    ];
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist }));

    component.loadAds();
    component.loadMetadata();
    fixture.detectChanges();

    expect(component.waitlistFullyInHero).toBe(true);
    expect(component.waitlistBandEmpty).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('.col-side')!.classList)
      .toContain('is-hero-covered');
  });

  it('does not flag an empty waitlist as hero-covered', () => {
    mockMetadataService.getMetadata.mockReturnValue(of({ categories: [], waitlist: [] }));

    component.loadAds();
    component.loadMetadata();
    fixture.detectChanges();

    // .is-empty already hides this case, and it means the opposite thing:
    // nobody is waiting, rather than everyone waiting being shown above.
    expect(component.waitlistFullyInHero).toBe(false);
    expect(component.waitlistBandEmpty).toBe(true);
  });

  describe('phone home page redesign and gestures', () => {
    const mockMatchMedia = (matches: boolean) => {
      vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })));
    };

    afterEach(() => {
      vi.unstubAllGlobals();
      try {
        localStorage.clear();
      } catch {}
    });

    it('shows marketing hero on first visit on phone and records seenHero in localStorage', () => {
      mockMatchMedia(true);
      localStorage.removeItem('unibooks.home.seenHero');

      const testFixture = TestBed.createComponent(Home);
      const testComp = testFixture.componentInstance;
      testFixture.detectChanges();

      expect(testComp.isPhone).toBe(true);
      expect(testComp.seenHero).toBe(false);

      const el = testFixture.nativeElement as HTMLElement;
      const hero = el.querySelector('app-home-hero');
      expect(hero).toBeTruthy();
      expect(el.querySelector('.phone-home-header')).toBeNull();

      expect(localStorage.getItem('unibooks.home.seenHero')).toBe('true');
      testFixture.destroy();
    });

    it('does not render hero and shows compact search bar, category chips, and sr-only h1 on returning phone visits', () => {
      mockMatchMedia(true);
      localStorage.setItem('unibooks.home.seenHero', 'true');

      const testFixture = TestBed.createComponent(Home);
      const testComp = testFixture.componentInstance;
      testFixture.detectChanges();

      expect(testComp.isPhone).toBe(true);
      expect(testComp.seenHero).toBe(true);

      const el = testFixture.nativeElement as HTMLElement;
      const hero = el.querySelector('app-home-hero');
      expect(hero).toBeNull();

      // SEO & accessibility: sr-only h1 with the same title text remains in DOM
      const h1 = el.querySelector('h1.sr-only');
      expect(h1).toBeTruthy();
      expect(h1?.textContent).toContain('home.heroTitle');

      // Compact search field
      const searchField = el.querySelector('ui-search-field');
      expect(searchField).toBeTruthy();

      // Category chips
      const chips = el.querySelectorAll('.phone-category-chip');
      expect(chips.length).toBe(1);
      expect(chips[0].textContent).toContain('Cat 1');

      // Redundant category rail is hidden on phone redesign
      const catSection = el.querySelector('.categories-section');
      expect(catSection?.classList.contains('hide-on-phone-redesign')).toBe(true);

      testFixture.destroy();
    });

    it('typing and submitting navigates to the search page with q', () => {
      mockMatchMedia(true);
      localStorage.setItem('unibooks.home.seenHero', 'true');

      const testFixture = TestBed.createComponent(Home);
      const testComp = testFixture.componentInstance;
      testFixture.detectChanges();

      testComp.onSearch('algorithms');

      expect(router.navigate).toHaveBeenCalledWith(['/', 'tw', 'search'], {
        queryParams: { q: 'algorithms' }
      });
      testFixture.destroy();
    });

    it('empty search query does not navigate', () => {
      mockMatchMedia(true);
      localStorage.setItem('unibooks.home.seenHero', 'true');

      const testFixture = TestBed.createComponent(Home);
      const testComp = testFixture.componentInstance;
      testFixture.detectChanges();

      testComp.onSearch('   ');

      expect(router.navigate).not.toHaveBeenCalled();
      testFixture.destroy();
    });

    it('does not record ad impressions for hero ads on returning phone visits', () => {
      mockMatchMedia(true);
      localStorage.setItem('unibooks.home.seenHero', 'true');

      const heroAd: any = { id: 99, title: 'Ad Title', image_url: 'http://img.png', target_url: 'http://link.com', show_in_hero: true };
      mockMetadataService.getActiveAds.mockReturnValue(of({ results: [heroAd] }));
      const recordAdViewSpy = mockMetadataService.recordAdView;
      recordAdViewSpy.mockClear();

      const testFixture = TestBed.createComponent(Home);
      testFixture.detectChanges();

      expect(recordAdViewSpy).not.toHaveBeenCalledWith(99);
      testFixture.destroy();
    });

    it('keeps marketing hero visible on desktop even if seenHero is true in localStorage', () => {
      mockMatchMedia(false);
      localStorage.setItem('unibooks.home.seenHero', 'true');

      const testFixture = TestBed.createComponent(Home);
      const testComp = testFixture.componentInstance;
      testFixture.detectChanges();

      expect(testComp.isPhone).toBe(false);

      const el = testFixture.nativeElement as HTMLElement;
      const hero = el.querySelector('app-home-hero');
      expect(hero).toBeTruthy();
      expect(hero?.classList.contains('sr-only-phone')).toBe(false);
      expect(el.querySelector('.phone-home-header')).toBeNull();

      testFixture.destroy();
    });

    it('handles localStorage errors gracefully during initialization', () => {
      mockMatchMedia(true);
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage access blocked');
      });

      expect(() => {
        const testFixture = TestBed.createComponent(Home);
        testFixture.detectChanges();
        testFixture.destroy();
      }).not.toThrow();
    });

    it('pull to refresh reloads metadata and ads and resets refreshing', () => {
      component.refreshing = false;
      const metadataSpy = vi.spyOn(mockMetadataService, 'getMetadata');
      const adsSpy = vi.spyOn(mockMetadataService, 'getActiveAds');

      component.onRefresh();

      expect(component.refreshing).toBe(false);
      expect(metadataSpy).toHaveBeenCalled();
      expect(adsSpy).toHaveBeenCalled();
    });
  });
});
