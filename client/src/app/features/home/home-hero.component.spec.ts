import { RegionService } from '../../core/region.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HomeHero } from './home-hero.component';
import { provideRouter, Router } from '@angular/router';
import { I18nService } from '../../core/i18n.service';

/**
 * Search submission and the popular-query chips moved here from the home
 * component when the hero was split out; these are the same assertions that
 * used to live in home.spec.ts.
 */
describe('HomeHero', () => {
  let component: HomeHero;
  let fixture: ComponentFixture<HomeHero>;
  let mockI18n: any;
  let router: Router;

  beforeEach(async () => {
    mockI18n = {
      t: (key: string, params?: Record<string, string | number>) => {
        let text = key;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text += ` (${name}=${value})`;
          }
        }
        return text;
      },
      lang: () => 'zh-TW'
    };

    await TestBed.configureTestingModule({
      imports: [HomeHero],
      providers: [
        provideRouter([]),
        { provide: I18nService, useValue: mockI18n },
        { provide: RegionService, useValue: { currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }] } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(HomeHero);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  it('does not search when the translation key resolves to itself', () => {
    mockI18n.t = (key: string) => key;
    component.setSearchQueryFromKey('home.tagCalculus');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('searches using the translated string when one exists', () => {
    mockI18n.t = () => '微積分';
    component.setSearchQueryFromKey('home.tagCalculus');
    expect(router.navigate).toHaveBeenCalledWith(['/', 'tw', 'search'], {
      queryParams: { q: '微積分' },
      replaceUrl: true
    });
  });

  it('gives the search box an accessible name, not just a placeholder', () => {
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector('.hero-input input')!;
    expect(input.getAttribute('aria-label')).toBe('common.search');
  });

  it('does not navigate on an empty or whitespace-only query', () => {
    component.searchQuery = '   ';
    component.onSearch();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('routes a hero cover by isbn, falling back to id', () => {
    // No local_cache: the preview request travels as router state, so the
    // href stays the one URL a shared link should have.
    expect(component.heroBookParams({ id: 7, isbn: '978', title: 'x' }))
      .toEqual({ isbn: '978' });
    expect(component.heroBookParams({ id: 7, title: 'x' }))
      .toEqual({ id: 7 });
  });

  it('renders the request CTA when covers array is empty', () => {
    component.covers = [];
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const cta = compiled.querySelector('.hero-cta');
    const stack = compiled.querySelector('.hero-stack');
    expect(cta).not.toBeNull();
    expect(stack).toBeNull();
    expect(cta?.textContent).toContain('home.requestCtaTitle');
  });

  it('renders the cover stack and sponsored tag when hero ad cover is provided', () => {
    const heroAd: any = { id: 10, title: 'Ad Promo', image_url: 'http://ad.jpg', target_url: 'http://promo.com' };
    component.covers = [{
      id: 10,
      title: 'Ad Promo',
      coverUrl: 'http://ad.jpg',
      isAd: true,
      targetUrl: 'http://promo.com',
      adData: heroAd
    }];
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const stack = compiled.querySelector('.hero-stack');
    const cta = compiled.querySelector('.hero-cta');
    expect(stack).not.toBeNull();
    expect(cta).toBeNull();

    const adCard = compiled.querySelector('.cover-card') as HTMLAnchorElement;
    expect(adCard.href).toBe('http://promo.com/');
    expect(adCard.target).toBe('_blank');
    expect(adCard.rel).toContain('noopener');

    const sponsorTag = compiled.querySelector('.sponsor-tag');
    expect(sponsorTag).not.toBeNull();
    expect(sponsorTag?.textContent).toContain('home.sponsored');
  });

  it('renders demand tag capped at 9999+ when waiting count exceeds 9999', () => {
    component.covers = [
      { id: 1, title: 'Normal Book', count: 12 },
      { id: 2, title: 'Popular Book', count: 10500 }
    ];
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const tags = compiled.querySelectorAll('.demand-tag');
    expect(tags.length).toBe(2);
    expect(tags[0].textContent).toContain('n=12');
    expect(tags[1].textContent).toContain('n=9999+');
  });

  it('emits adClick when onHeroAdClick is called with adData', () => {
    const heroAd: any = { id: 10, title: 'Ad Promo' };
    const spy = vi.fn();
    component.adClick.subscribe(spy);

    component.onHeroAdClick({
      id: 10,
      title: 'Ad Promo',
      isAd: true,
      adData: heroAd
    });

    expect(spy).toHaveBeenCalledWith(heroAd);
  });

  it('keeps single cover centered with 0 offset and 0 hover-dir', () => {
    component.covers = [{ id: 1, title: 'Single Book' }];
    expect(component.heroCoverOffsets(0)).toBe('0px');
    expect(component.heroCoverRotations(0)).toBe('0deg');
    expect(component.heroCoverHoverDir(0)).toBe(0);
  });

  it('distributes 2 covers symmetrically without crossing', () => {
    component.covers = [{ id: 1, title: 'Book 1' }, { id: 2, title: 'Book 2' }];
    expect(component.heroCoverOffsets(0)).toBe('-18px');
    expect(component.heroCoverOffsets(1)).toBe('24px');
    expect(component.heroCoverHoverDir(0)).toBe(-0.6);
    expect(component.heroCoverHoverDir(1)).toBe(0.6);
  });

  it('keeps front cover centered and fans side covers left and right for 3 covers', () => {
    component.covers = [
      { id: 1, title: 'Front Book' },
      { id: 2, title: 'Right Book' },
      { id: 3, title: 'Left Book' }
    ];
    // Front book stays at center
    expect(component.heroCoverOffsets(0)).toBe('0px');
    expect(component.heroCoverHoverDir(0)).toBe(0);

    // Right book fans right
    expect(component.heroCoverOffsets(1)).toBe('42px');
    expect(component.heroCoverHoverDir(1)).toBe(1);

    // Left book fans left
    expect(component.heroCoverOffsets(2)).toBe('-32px');
    expect(component.heroCoverHoverDir(2)).toBe(-1);
  });
});
