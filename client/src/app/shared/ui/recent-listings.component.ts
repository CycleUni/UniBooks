import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, Input, Output, EventEmitter, inject, ChangeDetectorRef, effect, DestroyRef, TemplateRef, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subject, of } from 'rxjs';
import { switchMap, catchError, debounceTime } from 'rxjs/operators';
import { UiBookTile } from './book-tile.component';
import { UiPromoBanner } from './promo-banner.component';
import { UiSkeleton } from './skeleton.component';
import { UiPagination } from './pagination.component';
import { UiErrorState } from './error-state.component';
import { ListingService } from '../../core/services/listing.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { bookPreviewState, bookQueryParams } from '../../core/book-preview';

/**
 * Books per page of recent_books/. The backend paginates this endpoint at its
 * REST_FRAMEWORK PAGE_SIZE (20) and `limit` only trims within that page, so
 * asking for more never returned more: the search page's `limit=4000` (and
 * the old default of 200, the backend's cap) were requests for 20 books that
 * also minted their own server cache keys. Ask for exactly what is shown.
 */
export const RECENT_BOOKS_PAGE_SIZE = 20;

@Component({
  selector: 'ui-recent-listings',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, UiBookTile, UiSkeleton, TPipe, UiPagination, UiErrorState, UiPromoBanner],
  template: `
    <h2 class="section-heading" [id]="headingId">
      <ng-container *ngIf="isCityFallback">{{ 'home.recentTitleCity' | t:{city: cityLabel} }}</ng-container>
      <ng-container *ngIf="!isCityFallback">{{ (school ? 'home.recentTitle' : 'home.recentTitleAll') | t }}</ng-container>
    </h2>
    <!-- The school had nothing, so these are its city's: said up front, so
         nobody takes them for copies at their own school. -->
    <p class="fallback-note" *ngIf="isCityFallback && !loading">
      {{ 'home.cityFallbackNote' | t:{school: schoolLabel, city: cityLabel} }}
      <button type="button" class="fallback-link" (click)="showAllSchools()">{{ 'home.showAllSchools' | t }}</button>
    </p>
    <ng-container *ngIf="loading">
      <ui-skeleton variant="discover-grid" [count]="4"></ui-skeleton>
    </ng-container>
    <ng-container *ngIf="!loading">
      <ui-error-state
        *ngIf="errorMessage"
        [message]="errorMessage"
        (retry)="reload()"
      ></ui-error-state>
      <div class="discover-grid" [class.has-feature]="showFeatureTile" *ngIf="!errorMessage">
        <ng-container *ngFor="let item of gridItems; let i = index; trackBy: trackGridItem">
          <ng-container *ngIf="item.type === 'ad'">
            <ui-promo-banner [ad]="item.data" [feature]="showFeatureTile && i === 0" (adClick)="adClick.emit($event)"></ui-promo-banner>
          </ng-container>
          <ng-container *ngIf="item.type === 'book'">
            <ui-book-tile
              [feature]="showFeatureTile && i === 0"
              [priority]="i < 2"
              [title]="item.data.title || ('home.unknownBook' | t)"
              [author]="item.data.authors"
              [isbn]="item.data.isbn"
              [coverUrl]="item.data.cover_url"
              [sellerCount]="sellerCountFor(item.data.conditions)"
              [conditions]="item.data.conditions"
              [minPrice]="item.data.min_price"
              [isFromPrice]="item.data.max_price > item.data.min_price"
              [link]="['/book']"
              [linkParams]="bookLinkParams(item.data)"
              [linkState]="previewState"
              (tileClick)="cacheBook(item.data)"
            ></ui-book-tile>
          </ng-container>
        </ng-container>

        <!-- Cold start: a grid with two books in it reads as "nobody is here".
             One supply-side invitation after the books turns the emptiest
             part of the page into the one CTA the marketplace most needs.
             A single tile — repeating it reads as filler, not an invitation. -->
        <a class="seed-tile hover-card hover-card-surface" regionLink="/sell" *ngIf="showSeedTile">
          <span class="seed-mark" aria-hidden="true">+</span>
          <span class="seed-text">{{ 'home.seedSlot' | t }}</span>
        </a>
      </div>
      <p *ngIf="recentBooks.length === 0 && !errorMessage" class="empty-note">{{ 'home.noListings' | t }}</p>
      <ui-pagination *ngIf="totalCount > pageSize" [total]="totalCount" [pageSize]="pageSize" [currentPage]="currentPage" (pageChange)="onPageChange($event)"></ui-pagination>
    </ng-container>
  `,
  styles: [`
    /* A query container so the feature tile can react to the width of the
       grid itself rather than the viewport — the same grid is 715px wide
       beside the waitlist and 1120px wide once that column stacks. */
    :host { display: block; container-type: inline-size; }
    /* Auto-fill rather than a fixed 4 columns. At 1120px, 'repeat(4, 1fr)' in
       the two-thirds-width home column produced 153px covers — too small to
       read a spine title on a desktop screen — and any book count that isn't
       a multiple of 4 left visible holes in the grid. Sizing by a 180px
       minimum instead lets the column count follow the space available. */
    .fallback-note {
      margin: calc(-1 * var(--space-2)) 0 var(--space-4);
      font-size: var(--text-sm);
      color: var(--muted);
    }
    .fallback-link {
      display: inline-flex;
      align-items: center;
      min-height: var(--tap-min);
      padding: 0 var(--space-1);
      border: 0;
      background: none;
      font: inherit;
      color: var(--ink);
      text-decoration: underline;
      cursor: pointer;
    }
    .seed-tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      aspect-ratio: 5 / 7;
      border: 1px dashed var(--line-strong);
      border-radius: var(--radius-xs);
      text-decoration: none;
      color: var(--muted);
      background-color: var(--paper-warm);
      transition: border-color var(--motion-base), color var(--motion-base), background-color var(--motion-base);
    }
    .seed-mark {
      font-family: 'Noto Serif TC', serif;
      font-size: var(--text-3xl);
      line-height: 1;
    }
    .seed-text {
      font-size: var(--text-sm);
      text-align: center;
      padding-inline: var(--space-3);
    }
  `]
})
export class UiRecentListings {
  @Input() set school(val: string) {
    this._school = val;
    this.fetchRecentBooks();
  }
  get school() { return this._school; }
  private _school = '';

  @Input() set limit(val: number) {
    this._limit = val;
    this.fetchRecentBooks();
  }
  get limit() { return this._limit; }
  private _limit = RECENT_BOOKS_PAGE_SIZE;

  /** What one page of the grid shows; see RECENT_BOOKS_PAGE_SIZE. */
  readonly pageSize = RECENT_BOOKS_PAGE_SIZE;

  @Input() ads: any[] = [];
  @Output() adClick = new EventEmitter<any>();

  recentBooks: any[] = [];
  /** 'city' when the school had no books and these are its city's instead. */
  scope: 'all' | 'school' | 'city' = 'all';
  /** Code of the selected school's city, from the response. */
  city: string | null = null;
  loading = true;
  errorMessage: string = '';
  totalCount = 0;
  currentPage = 1;

  /** Stable id so the parent <section> can point aria-labelledby at this heading. */
  readonly headingId = 'recent-listings-heading';

  /**
   * The span-2 feature tile needs enough siblings around it to read as
   * emphasis rather than as a broken cell. Below this count every tile is
   * the same size.
   */
  private static readonly FEATURE_MIN_BOOKS = 5;

  /** Below this many books the grid shows the "list your book" tile. */
  private static readonly COLD_START_SLOTS = 3;

  /**
   * Built once per change of books or ads, not on every read. As a plain
   * getter it wrapped every book in a new object on each change detection,
   * and *ngFor (tracking by identity) destroyed and recreated every tile each
   * time. A cover that failed to load fired (error), which ran change
   * detection, which recreated the tile, which requested the cover again: an
   * endless request loop per open page, and the placeholder never stayed up
   * long enough to be seen. It burned through the Pages Functions quota that
   * /api/cover shares with CFEdgeChat.
   */
  private gridMemo: { books: any[]; ads: any[] | undefined; value: any[] } | null = null;

  get gridItems(): any[] {
    if (this.gridMemo && this.gridMemo.books === this.recentBooks && this.gridMemo.ads === this.ads) {
      return this.gridMemo.value;
    }
    const value = this.buildGridItems();
    this.gridMemo = { books: this.recentBooks, ads: this.ads, value };
    return value;
  }

  /** Same tile for the same book or ad across rebuilds (a page change, a refetch). */
  trackGridItem(index: number, item: any): string {
    return `${item.type}:${item.data?.id ?? item.data?.isbn ?? index}`;
  }

  private buildGridItems(): any[] {
    const items: any[] = [...this.recentBooks];
    if (this.ads && this.ads.length) {
      const sortedAds = [...this.ads].sort((a, b) => (a.slot_index || 1) - (b.slot_index || 1));
      for (const ad of sortedAds) {
        let insertIndex = (ad.slot_index || 1) - 1;
        if (insertIndex < 0) insertIndex = 0;
        if (insertIndex > items.length) insertIndex = items.length;
        items.splice(insertIndex, 0, { type: 'ad', data: ad });
      }
    }
    return items.map(item => item.type === 'ad' ? item : { type: 'book', data: item });
  }

  get showFeatureTile(): boolean {
    return this.recentBooks.length >= UiRecentListings.FEATURE_MIN_BOOKS;
  }

  /** One "list your book" tile while the catalogue is nearly empty —
      including fully empty, where it is the page's only way in to selling. */
  get showSeedTile(): boolean {
    if (this.loading || this.errorMessage) return false;
    return this.recentBooks.length < UiRecentListings.COLD_START_SLOTS;
  }

  private listingService = inject(ListingService);
  private schoolState = inject(SchoolStateService);

  get isCityFallback(): boolean {
    return this.scope === 'city' && !!this.school;
  }

  get schoolLabel(): string {
    return this.schoolState.getSchoolLabel(this.school);
  }

  get cityLabel(): string {
    return this.schoolState.getCityLabel(this.city);
  }

  /** Leave the empty school for every university's books, as the header picker would. */
  showAllSchools() {
    this.schoolState.setManualSchool('');
  }
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);
  private destroyRef = inject(DestroyRef);

  // `school`/`limit` inputs can each fire their own fetch in quick succession
  // (e.g. `school` starts as '' and is then updated once the user's actual
  // school resolves asynchronously). Routing every fetch through switchMap
  // guarantees an older, still-in-flight request can never overwrite the UI
  // after a newer one has already resolved.
  private fetchTrigger$ = new Subject<void>();

  private reloadCallbacks: Array<() => void> = [];

  constructor() {
    // debounceTime(0): the school and limit inputs and the language effect
    // each ask for a fetch as the component starts, all in the same turn.
    // switchMap cancelled all but the last in the browser, but each had
    // already reached the backend; now they are one request.
    this.fetchTrigger$.pipe(
      debounceTime(0),
      switchMap(() => {
        this.loading = true;
        this.cdr.markForCheck();
        return this.listingService.getRecentBooks(this.school, this.currentPage, this.limit).pipe(
          catchError(() => of(null))
        );
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe((data) => {
      if (data === null) {
        this.recentBooks = [];
        this.scope = 'all';
        this.city = null;
        this.errorMessage = this.i18n.t('home.listingsError');
      } else {
        this.recentBooks = data.results || data;
        this.totalCount = data.count || this.recentBooks.length;
        this.scope = data.scope || (this.school ? 'school' : 'all');
        this.city = data.city || null;
        this.errorMessage = '';
      }
      this.loading = false;
      this.cdr.markForCheck();
      const cbs = this.reloadCallbacks;
      this.reloadCallbacks = [];
      cbs.forEach(cb => cb());
    });

    effect(() => {
      // Re-fetch when language changes so localized error/titles update if needed
      this.i18n.lang();
      untracked(() => this.fetchRecentBooks());
    });
  }

  private fetchRecentBooks() {
    this.fetchTrigger$.next();
  }

  onPageChange(page: number) {
    this.currentPage = page;
    this.fetchRecentBooks();
  }

  sellerCountFor(conditions: any): number {
    if (!conditions) return 0;
    return Object.values(conditions).reduce((sum: number, count: any) => sum + (Number(count) || 0), 0);
  }

  trackById(index: number, item: any): any {
    return item.id;
  }

  /** Anchors carry the navigation now; this only primes the detail-page cache. */
  cacheBook(item: any) {
    if (typeof sessionStorage === 'undefined') return;
    const cached = {
      id: item.id,
      title: item.title,
      author: item.authors,
      isbn: item.isbn,
      coverUrl: item.cover_url,
      activeListings: 1
    };
    sessionStorage.setItem(`cachedBook_${item.isbn || item.id}`, JSON.stringify(cached));
  }

  /** Lets the book page show what cacheBook() stashed; carried outside the URL. */
  readonly previewState = bookPreviewState();

  bookLinkParams(item: any): Record<string, any> {
    return bookQueryParams(item);
  }

  reload(onComplete?: () => void) {
    if (onComplete) {
      this.reloadCallbacks.push(onComplete);
    }
    this.fetchRecentBooks();
  }
}
