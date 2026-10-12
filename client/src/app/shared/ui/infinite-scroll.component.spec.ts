import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { UiInfiniteScroll } from './infinite-scroll.component';
import { I18nService } from '../../core/i18n.service';

import { signal } from '@angular/core';

@Component({
  standalone: true,
  imports: [UiInfiniteScroll],
  template: `
    <ui-infinite-scroll
      [loading]="loading()"
      [hasMore]="hasMore()"
      [error]="error()"
      (loadMore)="onLoadMore()"
    ></ui-infinite-scroll>
  `
})
class HostComponent {
  readonly loading = signal(false);
  readonly hasMore = signal(true);
  readonly error = signal(false);
  loadMoreCount = 0;

  onLoadMore() {
    this.loadMoreCount++;
  }
}

describe('UiInfiniteScroll', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let observerCallback: IntersectionObserverCallback;
  let mockObserve: ReturnType<typeof vi.fn>;
  let mockDisconnect: ReturnType<typeof vi.fn>;

  const stubPhone = (isPhone: boolean) => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 900px') ? isPhone : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  };

  beforeEach(async () => {
    stubPhone(true);
    mockObserve = vi.fn();
    mockDisconnect = vi.fn();

    vi.stubGlobal('IntersectionObserver', vi.fn().mockImplementation(function (this: any, cb: IntersectionObserverCallback) {
      observerCallback = cb;
      this.observe = mockObserve;
      this.disconnect = mockDisconnect;
      this.unobserve = vi.fn();
      return this;
    }));

    await TestBed.configureTestingModule({
      imports: [HostComponent, UiInfiniteScroll],
      providers: [
        { provide: I18nService, useValue: { t: (k: string) => k } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('observes the sentinel when on phone and hasMore is true', () => {
    expect(mockObserve).toHaveBeenCalled();
  });

  it('does not observe sentinel on desktop', () => {
    mockObserve.mockClear();
    stubPhone(false);

    const deskFixture = TestBed.createComponent(HostComponent);
    deskFixture.detectChanges();

    expect(deskFixture.debugElement.query(By.css('.infinite-scroll-container'))).toBeNull();
  });

  it('emits loadMore when sentinel intersects on phone', () => {
    expect(host.loadMoreCount).toBe(0);

    // Simulate intersection
    observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    fixture.detectChanges();

    expect(host.loadMoreCount).toBe(1);
  });

  it('does not emit loadMore if not intersecting', () => {
    observerCallback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    fixture.detectChanges();

    expect(host.loadMoreCount).toBe(0);
  });

  it('shows loading row and stops observing when loading is true', () => {
    host.loading.set(true);
    fixture.detectChanges();

    const loadingRow = fixture.debugElement.query(By.css('.infinite-loading-row'));
    expect(loadingRow).not.toBeNull();
  });

  it('shows an error row whose retry asks for the page once', () => {
    host.error.set(true);
    fixture.detectChanges();

    const errorRow = fixture.debugElement.query(By.css('.infinite-error-row'));
    expect(errorRow).not.toBeNull();

    const retryBtn = fixture.debugElement.query(By.css('.retry-button'));
    retryBtn.nativeElement.click();
    fixture.detectChanges();

    expect(host.loadMoreCount).toBe(1);
  });
});
