import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UiBookCover } from './book-cover.component';
import { I18nService } from '../../core/i18n.service';
import { By } from '@angular/platform-browser';
import { RegionService } from '../../core/region.service';


describe('UiBookCover', () => {
  let component: UiBookCover;
  let fixture: ComponentFixture<UiBookCover>;
  let mockI18n: any;

  beforeEach(() => {
    mockI18n = {
      lang: () => 'en',
      t: (key: string) => `Translated: ${key}`
    };

    TestBed.configureTestingModule({
      imports: [UiBookCover],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        { provide: I18nService, useValue: mockI18n }
      ]
    });
    fixture = TestBed.createComponent(UiBookCover);
    component = fixture.componentInstance;
  });

  it('renders an image when coverUrl is provided', () => {
    fixture.componentRef.setInput('coverUrl', 'https://books.google.com/books?id=123');
    fixture.componentRef.setInput('title', 'Clean Architecture');
    fixture.detectChanges();

    const img = fixture.debugElement.query(By.css('img'));
    expect(img).toBeTruthy();
    // Google Books URLs are proxied through /api/cover?src=<encoded url>, so
    // the zoom param is percent-encoded inside `src` rather than literal.
    expect(decodeURIComponent(img.nativeElement.src)).toContain('zoom=3');
    expect(img.nativeElement.alt).toBe('Clean Architecture');
    expect(fixture.debugElement.query(By.css('.book-placeholder'))).toBeNull();
  });

  it('loads lazily by default', () => {
    fixture.componentRef.setInput('coverUrl', 'https://books.google.com/books?id=123');
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.hasAttribute('fetchpriority')).toBe(false);
  });

  it('loads a priority cover at once and ahead of other images', () => {
    fixture.componentRef.setInput('coverUrl', 'https://books.google.com/books?id=123');
    fixture.componentRef.setInput('priority', true);
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('fetchpriority')).toBe('high');
  });

  it('passes the zoom level to the bookCover pipe', () => {
    fixture.componentRef.setInput('coverUrl', 'https://books.google.com/books?id=123');
    fixture.componentRef.setInput('zoom', 2);
    fixture.detectChanges();

    const img = fixture.debugElement.query(By.css('img'));
    expect(decodeURIComponent(img.nativeElement.src)).toContain('zoom=2');
  });

  it('routes Google Books URLs through the /api/cover proxy', () => {
    fixture.componentRef.setInput('coverUrl', 'https://books.google.com/books?id=123');
    fixture.componentRef.setInput('zoom', 3);
    fixture.detectChanges();

    const img = fixture.debugElement.query(By.css('img'));
    // The pipe wraps Google Books URLs as /api/cover?src=<encoded original url>,
    // which the server Worker's /api/cover route (server/src/services/frontend/cover.ts) validates
    // server-side (cascading zoom tiers, real 404 on failure) — this component
    // no longer needs any client-side placeholder-detection heuristics.
    expect(img.nativeElement.src).toContain('/api/cover?src=');
  });

  it('renders book-placeholder with title, author, and isbn when coverUrl is absent', () => {
    fixture.componentRef.setInput('title', 'Design Patterns');
    fixture.componentRef.setInput('author', 'Gang of Four');
    fixture.componentRef.setInput('isbn', '9780201633610');
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('img'))).toBeNull();
    const placeholder = fixture.debugElement.query(By.css('.book-placeholder'));
    expect(placeholder).toBeTruthy();

    const title = fixture.debugElement.query(By.css('.bp-title')).nativeElement;
    const author = fixture.debugElement.query(By.css('.bp-author')).nativeElement;
    const isbn = fixture.debugElement.query(By.css('.bp-isbn')).nativeElement;

    expect(title.textContent).toBe('Design Patterns');
    expect(author.textContent).toBe('Gang of Four');
    expect(isbn.textContent).toBe('9780201633610');
  });

  it('switches to book-placeholder when image encounters an error', () => {
    fixture.componentRef.setInput('coverUrl', 'https://example.com/bad-image.jpg');
    fixture.detectChanges();

    expect(component.imageBroken).toBe(false);
    const img = fixture.debugElement.query(By.css('img'));
    expect(img).toBeTruthy();

    img.triggerEventHandler('error', new Event('error'));
    fixture.detectChanges();

    expect(component.imageBroken).toBe(true);
    expect(fixture.debugElement.query(By.css('img'))).toBeNull();
    expect(fixture.debugElement.query(By.css('.book-placeholder'))).toBeTruthy();
  });

  it('resets imageBroken when coverUrl input changes', () => {
    fixture.componentRef.setInput('coverUrl', 'https://example.com/bad-image.jpg');
    fixture.detectChanges();

    component.onImageError();
    expect(component.imageBroken).toBe(true);

    fixture.componentRef.setInput('coverUrl', 'https://example.com/new-image.jpg');
    fixture.detectChanges();

    expect(component.imageBroken).toBe(false);
  });

  it('falls back to translated unknownBook alt text when title is empty', () => {
    fixture.componentRef.setInput('coverUrl', 'https://example.com/book.jpg');
    fixture.detectChanges();

    const img = fixture.debugElement.query(By.css('img')).nativeElement;
    expect(img.alt).toBe('Translated: home.unknownBook');
  });

  it('prefers explicit alt text when supplied', () => {
    fixture.componentRef.setInput('coverUrl', 'https://example.com/book.jpg');
    fixture.componentRef.setInput('title', 'Title');
    fixture.componentRef.setInput('alt', 'Custom Alt');
    fixture.detectChanges();

    const img = fixture.debugElement.query(By.css('img')).nativeElement;
    expect(img.alt).toBe('Custom Alt');
  });
  it('does not ask again for a cover that already failed, in any instance', () => {
    const url = 'https://covers.openlibrary.org/b/isbn/0000000000001-L.jpg';
    fixture.componentRef.setInput('coverUrl', url);
    fixture.detectChanges();
    fixture.debugElement.query(By.css('img')).nativeElement.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('img'))).toBeNull();

    // A new instance — a re-created tile, or the same book on another page —
    // goes straight to the placeholder.
    const again = TestBed.createComponent(UiBookCover);
    again.componentRef.setInput('coverUrl', url);
    again.detectChanges();
    expect(again.debugElement.query(By.css('img'))).toBeNull();
    expect(again.debugElement.query(By.css('.book-placeholder'))).toBeTruthy();
  });
});
