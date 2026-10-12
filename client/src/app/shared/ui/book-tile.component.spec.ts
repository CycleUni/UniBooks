import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UiBookTile } from './book-tile.component';
import { I18nService } from '../../core/i18n.service';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RegionService } from '../../core/region.service';


describe('UiBookTile', () => {
  let component: UiBookTile;
  let fixture: ComponentFixture<UiBookTile>;
  let mockI18n: any;

  beforeEach(() => {
    mockI18n = {
      lang: () => 'en',
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

    TestBed.configureTestingModule({
      imports: [UiBookTile],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        provideRouter([]),
        { provide: I18nService, useValue: mockI18n }
      ]
    });
    fixture = TestBed.createComponent(UiBookTile);
    component = fixture.componentInstance;
  });

  it('should render the book title', () => {
    component.title = 'Calculus: Early Transcendentals';
    fixture.detectChanges();
    const title = fixture.debugElement.query(By.css('.tile-title')).nativeElement;
    expect(title.textContent).toContain('Calculus: Early Transcendentals');
  });

  it('shows the ISBN without a leading separator when the author is missing', () => {
    component.isbn = '9786269293919';
    fixture.detectChanges();
    const meta = fixture.debugElement.query(By.css('.tile-meta')).nativeElement;
    expect(meta.textContent.trim()).toBe('9786269293919');
  });

  it('separates the author and ISBN when both are present', () => {
    component.author = 'Stewart';
    component.isbn = '9786269293919';
    fixture.detectChanges();
    const meta = fixture.debugElement.query(By.css('.tile-meta')).nativeElement;
    expect(meta.textContent.replace(/\s+/g, ' ').trim()).toBe('Stewart · 9786269293919');
  });

  it('sellers mode: shows a price stamp and seller-count line', () => {
    component.mode = 'sellers';
    component.sellerCount = 4;
    component.minPrice = 250;
    fixture.detectChanges();

    const priceTag = fixture.debugElement.query(By.css('.price-tag'));
    expect(priceTag).toBeTruthy();
    expect(priceTag.nativeElement.textContent).toContain('bookTile.price');

    const sellers = fixture.debugElement.query(By.css('.tile-sellers'));
    expect(sellers).toBeTruthy();
    expect(sellers.nativeElement.textContent).toContain('bookTile.sellerCount');
    expect(sellers.nativeElement.textContent).toContain('n=4');
  });

  it('sellers mode: caps sellerCount at 9999+ when it exceeds threshold', () => {
    component.mode = 'sellers';
    component.sellerCount = 10000;
    component.minPrice = 250;
    fixture.detectChanges();

    const sellers = fixture.debugElement.query(By.css('.tile-sellers'));
    expect(sellers).toBeTruthy();
    expect(sellers.nativeElement.textContent).toContain('bookTile.sellerCount');
    expect(sellers.nativeElement.textContent).toContain('n=9999+');
  });

  it('sellers mode: quotes the price as a starting price when isFromPrice is set', () => {
    component.mode = 'sellers';
    component.minPrice = 300;
    component.isFromPrice = true;
    fixture.detectChanges();

    const priceTag = fixture.debugElement.query(By.css('.price-tag'));
    expect(priceTag.nativeElement.textContent).toContain('bookTile.priceFrom');
  });

  it('waitlist mode: shows a waiting-count stamp and no seller line', () => {
    component.mode = 'waitlist';
    component.waitingCount = 7;
    fixture.detectChanges();

    const priceTag = fixture.debugElement.query(By.css('.price-tag.waitlist'));
    expect(priceTag).toBeTruthy();
    expect(priceTag.nativeElement.textContent).toContain('home.waitingCount');
    expect(priceTag.nativeElement.textContent).toContain('n=7');

    const sellers = fixture.debugElement.query(By.css('.tile-sellers'));
    expect(sellers).toBeNull();
  });

  it('waitlist mode: caps waitingCount at 9999+ when it exceeds threshold', () => {
    component.mode = 'waitlist';
    component.waitingCount = 12500;
    fixture.detectChanges();

    const priceTag = fixture.debugElement.query(By.css('.price-tag.waitlist'));
    expect(priceTag).toBeTruthy();
    expect(priceTag.nativeElement.textContent).toContain('home.waitingCount');
    expect(priceTag.nativeElement.textContent).toContain('n=9999+');
  });

  it('emits tileClick when the tile is clicked', () => {
    let emitted = false;
    component.tileClick.subscribe(() => emitted = true);
    fixture.detectChanges();

    const tile = fixture.debugElement.query(By.css('.tile-body'));
    tile.nativeElement.click();

    expect(emitted).toBe(true);
  });

  // Without `link` the tile still has to be focusable, so it falls back to a
  // button rather than the un-tabbable div this used to be.
  it('falls back to a focusable button when no link is supplied', () => {
    fixture.detectChanges();

    const fallback = fixture.debugElement.query(By.css('.tile-body'));
    expect(fallback.nativeElement.tagName).toBe('BUTTON');
  });

  it('renders a real anchor with an href when a link is supplied', () => {
    component.link = ['/book'];
    component.linkParams = { isbn: '9781234567890' };
    fixture.detectChanges();

    const anchor = fixture.debugElement.query(By.css('.tile-body'));
    expect(anchor.nativeElement.tagName).toBe('A');
    expect(anchor.nativeElement.getAttribute('href')).toContain('9781234567890');
  });

  it('does not print a real-looking price when no price is known', () => {
    component.mode = 'sellers';
    component.minPrice = null;
    fixture.detectChanges();

    const priceTag = fixture.debugElement.query(By.css('.price-tag'));
    expect(priceTag.nativeElement.textContent).toContain('bookTile.priceUnknown');
    expect(priceTag.nativeElement.textContent).not.toContain('0');
    expect(priceTag.nativeElement.classList).toContain('unpriced');
  });

  // 0 is a real price a seller can enter (campus giveaways), not a missing
  // value — the API uses null for "no listings". Conflating the two hid free
  // books behind an "ask the seller" label.
  it('shows a free listing as free rather than as an unknown price', () => {
    component.mode = 'sellers';
    component.minPrice = 0;
    fixture.detectChanges();

    const priceTag = fixture.debugElement.query(By.css('.price-tag'));
    expect(priceTag.nativeElement.textContent).toContain('bookTile.priceFree');
    expect(priceTag.nativeElement.textContent).not.toContain('bookTile.priceUnknown');
    expect(priceTag.nativeElement.classList).not.toContain('unpriced');
  });

  it('omits the waiting stamp when nobody is waiting', () => {
    component.mode = 'waitlist';
    component.waitingCount = 0;
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('.price-tag.waitlist'))).toBeNull();
  });

  it('shows the waiting stamp once at least one person is waiting', () => {
    component.mode = 'waitlist';
    component.waitingCount = 3;
    fixture.detectChanges();

    const stamp = fixture.debugElement.query(By.css('.price-tag.waitlist'));
    expect(stamp.nativeElement.textContent).toContain('n=3');
  });

  it('previews the conditions on offer, most-listed first and capped at two', () => {
    component.mode = 'sellers';
    component.conditions = { noted: 1, new: 5, like_new: 3 };
    fixture.detectChanges();

    expect(component.conditionKeys).toEqual(['new', 'like_new']);
    const chips = fixture.debugElement.queryAll(By.css('.cond-chip'));
    expect(chips.length).toBe(2);
    expect(chips[0].nativeElement.textContent).toContain('cond.new');
  });

  it('falls back to a placeholder cover when coverUrl is missing', () => {
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.placeholder'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('img'))).toBeNull();
  });

  it('marks the image as broken when it fails to load, so the placeholder takes over', () => {
    component.coverUrl = 'https://example.com/cover.jpg';
    fixture.detectChanges();
    const img = fixture.debugElement.query(By.css('img'));
    expect(img).toBeTruthy();

    img.triggerEventHandler('error', new Event('error'));
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('img'))).toBeNull();
    expect(fixture.debugElement.query(By.css('.placeholder'))).toBeTruthy();
  });
});

