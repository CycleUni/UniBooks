import { Component, OnInit, inject, effect, untracked, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { Subscription, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { UiButton } from '../../shared/ui/button.component';
import { UiBackButton } from '../../shared/ui/back-button.component';
import { UiBreadcrumb, BreadcrumbItem } from '../../shared/ui/breadcrumb.component';
import { RegionService } from '../../core/region.service';
import { BookService, SearchEngine, engineForSource, parseSearchEngine } from '../../core/services/book.service';
import { AccountService } from '../../core/services/account.service';
import { AuthStore } from '../../core/auth.store';
import { ChangeDetectorRef } from '@angular/core';
import { onLanguageChange } from '../../core/on-language-change';
import { I18nService, TPipe } from '../../core/i18n.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { UiListingCard } from '../../shared/ui/listing-card.component';
import { UiBookCover } from '../../shared/ui/book-cover.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiInfiniteScroll } from '../../shared/ui/infinite-scroll.component';
import { injectIsPhone } from '../../core/viewport';
import { PhonePager } from '../../core/phone-pager';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiVerificationPrompt } from '../../shared/ui/verification-prompt.component';
import { RegionLinkService } from '../../core/region-link.service';
import { ToastService } from '../../core/services/toast.service';
import { isOwnListing } from '../../core/own-listing';
import { SeoService } from '../../core/services/seo.service';
import { navigationWantsBookPreview, bookQueryParams } from '../../core/book-preview';
import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { displayPublisher } from '../../core/publisher';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';

import { bookSourceLabelKey } from '../../core/book-source';

export { BOOK_SOURCE_LABEL_KEYS, bookSourceLabelKey } from '../../core/book-source';

@Component({
  selector: 'app-book',
  standalone: true,
  imports: [CommonModule, RouterModule, UiButton, UiBackButton, UiBreadcrumb, TPipe, UiListingCard, UiBookCover, UiPagination, UiInfiniteScroll, UiEmpty, UiSkeleton, UiErrorState, UiVerificationPrompt],
  template: `
      <!-- Opened directly (no cached preview to paint first), the page used
           to stay blank until the book request answered. -->
      <div class="container container--narrow book-page" *ngIf="!book && isLoadingListings">
        <ui-skeleton variant="row" [count]="1"></ui-skeleton>
        <ui-skeleton variant="list" [count]="4"></ui-skeleton>
      </div>

      <!-- "Not found" only for a 404; any other failure may work on retry. -->
      <div class="container container--narrow book-page" *ngIf="!book && !isLoadingListings && bookId && !bookLoadFailed">
        <ui-empty [message]="'alert.bookNotFound' | t"></ui-empty>
      </div>

      <div class="container container--narrow book-page" *ngIf="!book && !isLoadingListings && bookLoadFailed">
        <ui-error-state [message]="'common.loadFailed' | t" (retry)="fetchBook()"></ui-error-state>
      </div>

      <div class="container container--narrow book-page" *ngIf="book">
        <ui-back-button></ui-back-button>

        <ui-breadcrumb [items]="breadcrumbItems"></ui-breadcrumb>

        <ui-verification-prompt
          *ngIf="showUnverifiedPrompt"
          (onDismiss)="showUnverifiedPrompt = false">
        </ui-verification-prompt>

        <div class="book-header">
          <div class="book-cover">
            <ui-book-cover
              [coverUrl]="book.cover_url"
              [title]="book.title"
              [author]="book.authors"
              [isbn]="book.isbn13"
              [zoom]="2"
            ></ui-book-cover>
          </div>
          <div class="book-info">
            <h2 class="book-title">{{ book.title }}</h2>
            <div class="meta-list">
              <div class="meta-row" *ngIf="book.authors">
                <span class="meta-label">{{ 'book.author' | t }}</span>
                <span class="meta-value">{{ book.authors }}</span>
              </div>
              <div class="meta-row" *ngIf="publisherLabel">
                <span class="meta-label">{{ 'book.publisher' | t }}</span>
                <span class="meta-value">{{ publisherLabel }}</span>
              </div>
              <div class="meta-row" *ngIf="book.published_date">
                <span class="meta-label">{{ 'book.year' | t }}</span>
                <span class="meta-value">{{ book.published_date }}</span>
              </div>
              <div class="meta-row" *ngIf="book.isbn13">
                <span class="meta-label">ISBN</span>
                <span class="meta-value"  style="font-family: monospace;">{{ book.isbn13 }}</span>
              </div>
            </div>
            <div class="waitlist-banner" [class.hot]="book.waiting_count > 0" *ngIf="!isLoadingListings && !listingsFailed && totalListings === 0">
              <span class="waitlist-count" [class.hot]="book.waiting_count > 0">
                {{ (book.waiting_count > 0 ? 'book.waitingBanner' : 'book.waitingBannerZero') | t:{n: book.waiting_count} }}
              </span>
              <ui-button *ngIf="!book.is_subscribed" variant="white" (onClick)="subscribeBook()">{{ 'search.notifyMe' | t }}</ui-button>
              <ui-button *ngIf="book.is_subscribed" variant="white"  style="color: var(--muted); border-color: var(--muted);" (onClick)="unsubscribeBook()">{{ 'search.cancelNotify' | t }}</ui-button>
            </div>
          </div>
        </div>

        <div class="listings-section">
          <h3 class="section-heading" *ngIf="!isLoadingListings && !listingsFailed">{{ 'book.currentListings' | t:{n: totalListings} }}</h3>
          <h3 class="section-heading" *ngIf="isLoadingListings || listingsFailed">{{ 'book.currentListings' | t:{n: '-'} }}</h3>
          
          <ui-skeleton *ngIf="isLoadingListings" variant="list" [count]="3"></ui-skeleton>

          <!-- The book is on screen (a cached preview, or a reload of a page
               already shown) but its listings did not come: "nobody is
               selling this" would be a claim nothing backs. -->
          <ui-error-state
            *ngIf="!isLoadingListings && listingsFailed"
            [message]="'book.listingsLoadFailed' | t"
            (retry)="fetchBook(true)"
          ></ui-error-state>

          <div class="no-local-alert" *ngIf="!isLoadingListings && !listingsFailed && listings.length > 0 && localListingsCount === 0 && currentSchool">
            {{ 'search.noLocalListings' | t:{school: currentSchoolLabel} }}
          </div>

          <div class="listings-grid" *ngIf="!isLoadingListings && !listingsFailed && listings.length > 0">
            <ui-listing-card *ngFor="let item of listings" 
              [item]="item"
              [isOwn]="isOwnListing(item)"
              (onClickCard)="openListing($event)"
              (onBuyNow)="buyNow($event)"
              (onContactSeller)="contactSeller($event)"
            ></ui-listing-card>
          </div>
          
          <ui-pagination *ngIf="!isPhone && !isLoadingListings && !listingsFailed && totalListings > 20" [total]="totalListings" [pageSize]="20" [currentPage]="currentPage" (pageChange)="onPageChange($event)"></ui-pagination>
          <ui-infinite-scroll *ngIf="isPhone && !isLoadingListings && !listingsFailed && listings.length > 0" [loading]="loadingMore" [hasMore]="hasMoreListings" [error]="loadMoreError" (loadMore)="onLoadMore()"></ui-infinite-scroll>

          <ui-empty *ngIf="!isLoadingListings && !listingsFailed && listings.length === 0" [message]="'book.emptyState' | t"></ui-empty>
        </div>

        <p class="data-source" *ngIf="sourceLabelKey as key">
          {{ 'book.dataSource' | t:{ source: (key | t) } }}
        </p>
      </div>
  `,
  styles: [`
    /* Width comes from .container--narrow. The old rule redeclared
       .container at 960px with border-box padding, i.e. a 928px column — 96px
       narrower than the header band, the widest left-edge jump in the app. */
    .book-page {
      padding-block: var(--space-6);
    }
    
    .book-header {
      display: flex;
      gap: 32px;
      margin-bottom: 48px;
    }
    .book-cover {
      width: 200px;
      height: 280px;
      background-color: var(--line);
      flex-shrink: 0;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card);
      overflow: hidden;
      transform: rotate(-1.4deg);
    }
    .book-info {
      flex: 1;
      min-width: 0;
    }
    .book-title {
      margin-top: 0;
      margin-bottom: 24px;
      font-size: var(--text-3xl);
      font-family: 'Noto Serif TC', serif;
      font-weight: 700;
      border-bottom: 2px solid var(--line);
      padding-bottom: 12px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    
    .meta-list {
      margin-bottom: 32px;
    }
    .meta-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      padding: 12px 0;
      border-top: 1px solid var(--line);
      font-size: var(--text-base);
    }
    .meta-row:first-child {
      border-top: none;
    }
    .meta-label {
      color: var(--muted);
      font-weight: 500;
    }
    .meta-value {
      color: var(--ink);
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .waitlist-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background-color: var(--paper-warm);
      border: 1px solid var(--line);
      border-radius: 4px;
    }
    .waitlist-banner.hot {
      background-color: var(--flag-light);
      border: 1px solid var(--flag-border);
    }
    .waitlist-count {
      color: var(--muted);
      font-weight: 500;
      font-size: var(--text-md);
    }
    .waitlist-count.hot {
      color: var(--flag);
      font-weight: 700;
    }

    /* One rule for every width. The old pair (280px above 768, 150px below)
       jumped at the breakpoint: four 175px cards at 768 became two 356px
       cards at 769, and 422px ones by 900. A minimum that tracks the grid
       width (19%) keeps four a row on a desktop, while the 150px floor
       still gives a phone two a row; between them a card stays roughly
       160-230px wide. */
    .listings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(max(150px, 19%), 1fr));
      gap: 16px;
    }
    .no-local-alert {
      padding: 12px 16px;
      margin-bottom: 24px;
      background-color: var(--danger-light);
      color: var(--danger);
      border-radius: 8px;
      font-size: var(--text-base);
      text-align: center;
    }
    /* A footnote, not content: it answers "where did these details come
       from" for the reader who wonders, and stays out of everyone else's way. */
    .data-source {
      margin: var(--space-7) 0 0;
      padding-top: var(--space-4);
      border-top: 1px solid var(--line);
      font-size: var(--text-xs);
      color: var(--ink-soft);
      text-align: center;
    }
    .course-info {
      font-size: var(--text-base);
      color: var(--muted);
      margin-bottom: 8px;
    }


    @media (max-width: 768px) {
      .book-header {
        flex-direction: column;
        gap: 24px;
        margin-bottom: 32px;
      }
      .book-cover {
        width: 140px;
        height: 196px;
        margin: 8px auto;
      }
      .book-title {
        font-size: var(--text-xl);
      }
      .meta-row {
        grid-template-columns: 88px 1fr;
        padding: 8px 0;
        font-size: var(--text-base);
      }
      .waitlist-banner {
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
        padding: 16px;
      }
      /* The card compacts itself when its own column gets narrow. */
      .listings-grid {
        gap: 12px;
      }
    }
  `]
})
export class Book implements OnInit {
  bookId: string | null = null;
  book: any = null;
  listings: any[] = [];
  totalListings = 0;
  localListingsCount = -1;
  currentSchool = '';

  /** A route-triggered fetch held until the opening school is known. */
  private fetchAwaitingSchool: (() => void) | null = null;

  /**
   * Runs `fetch` now if the opening school is settled, otherwise when it is —
   * so the first request already carries the school, instead of going out
   * for "all schools" and being repeated once the school arrives. Only the
   * latest held fetch runs.
   */
  private fetchOnceSchoolKnown(fetch: () => void): void {
    if (this.schoolStateService.ready) {
      fetch();
    } else {
      this.fetchAwaitingSchool = fetch;
    }
  }
  currentPage = 1;
  isLoadingListings = true;
  /** The book failed to load for a reason other than not existing. */
  bookLoadFailed = false;
  /** The book is shown but its listings failed to load. */
  listingsFailed = false;
  isVerified = false;
  showUnverifiedPrompt = false;
  private isPhoneSignal = injectIsPhone();
  get isPhone(): boolean { return this.isPhoneSignal(); }
  set isPhone(v: boolean) { this.isPhoneSignal.set(v); }
  private isLocalCache = false;
  // Which external catalogue to query when this ISBN isn't in our own DB
  // yet — defaults to 'googlebooks' server-side. Threaded through from the
  // route so a link built from a search result (rendered via a specific
  // engine, see search.ts's bookLinkParams) fetches from that same engine
  // instead of falling back to whichever one this page defaults to, which
  // is what caused the same ISBN to show a different cover here than on
  // the search result it was opened from.
  private engine: SearchEngine | null = null;
  // The catalogue the stashed search result came from, when it came from
  // one. Held back from the preview until the backend answers, but used if
  // that refresh fails: the preview on screen is that catalogue's data.
  private previewSource = '';

  get currentSchoolLabel(): string {
    return this.schoolStateService.getSchoolLabel(this.currentSchool);
  }

  /** Home › <book title>. No category level: the book payload carries no
   *  readable category, and fetching one would mean an extra request. */
  get breadcrumbItems(): BreadcrumbItem[] {
    if (!this.book) return [];
    return [
      { labelKey: 'nav.home', link: '/' },
      { label: this.book.title }
    ];
  }

  private bookService = inject(BookService);
  private ga = inject(GoogleAnalyticsService);
  /** The book whose view was already sent; pages of its listings are not new views. */
  private viewTracked: string | null = null;
  private accountService = inject(AccountService);
  private auth = inject(AuthStore);
  private regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private schoolStateService = inject(SchoolStateService);

  private isFirstSchoolEmission = true;

  private regionLink = inject(RegionLinkService);
  private seo = inject(SeoService);
  private destroyRef = inject(DestroyRef);

  readonly pager = new PhonePager<any>({
    fetchPage: (page) => {
      if (!this.bookId) {
        return of({ items: [], total: this.totalListings });
      }
      return this.bookService.getBook(this.bookId, page, this.currentSchool, this.engine ?? undefined).pipe(
        map(data => {
          let items: any[] = [];
          let total = this.totalListings;
          if (data.listings && !Array.isArray(data.listings)) {
            items = data.listings.results || [];
            total = data.listings.count || total;
          } else {
            items = data.listings || [];
          }
          return { items, total };
        })
      );
    },
    onAppend: (items) => {
      this.listings = [...this.listings, ...items];
      this.sortListings();
    },
    currentCount: () => this.listings.length,
    total: () => this.totalListings,
    cdr: this.cdr,
    destroyRef: this.destroyRef
  });

  get loadingMore(): boolean { return this.pager.loading; }
  get loadMoreError(): boolean { return this.pager.error; }
  get hasMoreListings(): boolean { return this.pager.hasMore; }
  get loadedPhonePage(): number { return this.pager.loadedPage; }

  constructor(private route: ActivatedRoute, private router: Router) {
    onLanguageChange(this.i18n, () => {
      if (this.bookId && !this.isLocalCache) {
        this.fetchBook();
      }
    });
  }

  ngOnInit() {
    // resolvedSchool$, not selectedSchool$: the latter starts as a provisional
    // '' and the page used to fetch the book for "all schools", then again
    // moments later for the school the layout settled on.
    // Both school streams outlive this page: without the teardown, every
    // book ever opened refetched itself on a school switch and retitled
    // whatever page was showing with its own name.
    this.schoolStateService.resolvedSchool$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(school => {
      const prev = this.currentSchool;
      this.currentSchool = school;

      const wasFirstEmission = this.isFirstSchoolEmission;
      this.isFirstSchoolEmission = false;

      const pending = this.fetchAwaitingSchool;
      this.fetchAwaitingSchool = null;
      if (pending) {
        pending();
      } else if (!wasFirstEmission && prev !== school && this.bookId && !this.isLocalCache) {
        this.fetchBook(true);
      } else {
        this.sortListings();
      }
      this.cdr.markForCheck();
    });

    this.schoolStateService.schools$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.cdr.markForCheck();
    });

    this.route.queryParamMap.subscribe(params => {
      const nextId = params.get('isbn') || params.get('id');
      const pageParam = Math.max(1, Number(params.get('page')) || 1);
      // Lists always start at page 1 on phone, ignoring ?page without rewriting the URL
      this.currentPage = this.isPhone ? 1 : pageParam;
      if (nextId !== this.bookId) {
        // A different book: drop the previous one so the skeleton shows
        // rather than the last book's page under the new URL.
        this.book = null;
        this.listings = [];
        this.totalListings = 0;
        this.isLoadingListings = true;
        this.bookLoadFailed = false;
        this.listingsFailed = false;
        this.pager.reset(this.currentPage, 0);
      }
      this.bookId = nextId;
      this.engine = parseSearchEngine(params.get('engine'));

      if (this.bookId) {
        // Only a click from a list page asks for the stashed preview, and it
        // says so in router state rather than the URL — see book-preview.ts.
        if (navigationWantsBookPreview(this.router)) {
          if (typeof sessionStorage !== 'undefined') {
            const cachedStr = sessionStorage.getItem(`cachedBook_${this.bookId}`);
            if (cachedStr) {
              try {
                const cached = JSON.parse(cachedStr);
                this.book = {
                  id: cached.id || '',
                  isbn13: cached.isbn || cached.isbn13 || '',
                  title: cached.title,
                  authors: cached.author || cached.authors || '',
                  publisher: cached.publisher || '',
                  published_date: cached.published_date || '',
                  cover_url: cached.coverUrl || cached.cover_url || '',
                  // Unknown until the backend answers: the stashed search
                  // result may carry a guessed 'manual', and the page footer
                  // would state that as the book's provenance.
                  source: '',
                  listings: { count: 0, results: [] },
                  waiting_count: cached.waitlistCount ?? 0,
                  is_subscribed: cached.is_subscribed ?? false,
                  subscription_id: cached.subscription_id ?? null
                };
                this.previewSource = engineForSource(cached.source) ? cached.source : '';
                this.isLocalCache = true;
                this.describePage();
                this.cdr.markForCheck();
                // The cached search result carries everything except the
                // actual listings, so hit the backend to get the real status
                this.fetchOnceSchoolKnown(() => this.fetchBook(true));
              } catch (e) {
                this.isLocalCache = false;
                this.fetchOnceSchoolKnown(() => this.fetchBook());
              }
            } else {
              this.isLocalCache = false;
              this.fetchOnceSchoolKnown(() => this.fetchBook());
            }
          } else {
            // Not in a browser environment (sessionStorage unavailable) — skip fetch.
            this.isLocalCache = true;
            // Nothing will resolve the loading state on this branch, so clear it
            // here or the listings section stays blank forever.
            this.isLoadingListings = false;
          }
        } else {
          this.isLocalCache = false;
          this.fetchOnceSchoolKnown(() => this.fetchBook());
        }
      }
    });

    if (this.auth.isLoggedIn()) {
      this.accountService.getMyProfile().subscribe({
        next: (profile) => {
          this.isVerified = this.auth.isVerifiedIn(this.book?.region || this.regionService.region());
          this.cdr.markForCheck();
        },
        error: () => {
          this.isVerified = false;
          this.cdr.markForCheck();
        }
      });
    }
  }

  fetchBook(silent = false) {
    this.isLoadingListings = true;
    this.bookLoadFailed = false;
    this.listingsFailed = false;
    this.pager.reset(this.currentPage, this.totalListings);
    // A silent refresh of an already-cached preview is only supposed to
    // supplement it with real listing status, not replace it — but when the
    // book has no local DB row, this refetch re-runs the same kind of
    // external lookup that produced the cached preview in the first place,
    // and Open Library (and Google Books) can return a different edition's
    // title/cover for a plain ISBN lookup than their own search endpoint
    // just showed on the search page (confirmed: their /api/books ISBN
    // endpoint and /search.json endpoint aren't guaranteed to agree). Since
    // the cached preview is exactly what the user just saw and clicked,
    // prefer it over a possibly-worse live re-lookup for this identity data.
    const previewToKeep = (silent && this.isLocalCache) ? this.book : null;
    this.bookService.getBook(this.bookId!, this.currentPage, this.currentSchool, this.engine ?? undefined).subscribe({
      next: (data) => {
        // `data.id` set means this came from our own catalog (an
        // authoritative record), not another external lookup — always
        // trust that over the preview.
        this.book = (previewToKeep && !data.id)
          ? { ...previewToKeep, source: data.source, listings: data.listings, waiting_count: data.waiting_count, is_subscribed: data.is_subscribed, subscription_id: data.subscription_id }
          : data;
        // handle both raw array (old API) or paginated object (new API)
        if (data.listings && !Array.isArray(data.listings)) {
          this.listings = data.listings.results || [];
          this.totalListings = data.listings.count || this.listings.length;
        } else {
          this.listings = data.listings || [];
          this.totalListings = this.listings.length;
        }
        this.pager.reset(this.currentPage, this.totalListings);
        this.localListingsCount = data.local_listings_count ?? -1;
        if (this.viewTracked !== this.bookId) {
          this.viewTracked = this.bookId ?? null;
          this.ga.trackViewBook({ id: data.id ?? this.bookId, isbn: data.isbn13, title: data.title, listingCount: this.totalListings });
        }
        this.describePage();
        this.isLoadingListings = false;
        this.isLocalCache = false;
        this.sortListings();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoadingListings = false;
        this.isLocalCache = false;
        // A silent fetch only supplements an already-rendered preview;
        // keep showing the preview instead of alarming the user
        if (silent && this.book && !this.book.source && this.previewSource) {
          this.book = { ...this.book, source: this.previewSource };
        }
        if (this.book) {
          // The book is on screen; only its listings are missing.
          this.listingsFailed = true;
        } else if (err?.status !== 404) {
          // Only a 404 means there is no such book; this may work on retry.
          this.bookLoadFailed = true;
        }
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Title, description, cover and canonical URL for this book.
   *
   * The canonical is always the ISBN form when the book has one: the same
   * book is reachable as ?id=, ?isbn= and with an &engine= hint, and only
   * one of those should be the address search engines keep.
   */
  private describePage() {
    const book = this.book;
    if (!book?.title) return;
    const identity = bookQueryParams({ isbn: book.isbn13, id: book.id || this.bookId });
    const canonicalPath = this.router.serializeUrl(
      this.router.createUrlTree(this.regionLink.path(['/book']), { queryParams: identity })
    );
    this.seo.setPage({
      title: book.title,
      descriptionKey: book.authors ? 'seo.bookDescription' : 'seo.bookDescriptionNoAuthor',
      descriptionParams: { title: book.title, authors: book.authors || '' },
      canonicalPath,
      image: book.cover_url ? new BookCoverPipe().transform(book.cover_url, 2) : undefined,
    });
  }

  /** i18n key for where this book's details came from, or null to show nothing. */
  get sourceLabelKey(): string | null {
    return bookSourceLabelKey(this.book?.source);
  }

  /** Publisher as shown; strips the quotes some catalogue records wrap it in. */
  get publisherLabel(): string {
    return displayPublisher(this.book?.publisher);
  }

  sortListings() {
    if (this.currentSchool && this.listings.length > 0) {
      const currentSchoolId = this.schoolStateService.getSchoolId(this.currentSchool);
      this.listings.sort((a, b) => {
        const aLocal = a.seller_school_id === currentSchoolId ? 1 : 0;
        const bLocal = b.seller_school_id === currentSchoolId ? 1 : 0;
        return bLocal - aLocal;
      });
    }
  }

  onPageChange(page: number) {
    this.currentPage = page;
    this.fetchBook();
  }

  onLoadMore() {
    this.pager.loadMore();
  }

  getConditionLabel(cond: string): string {
    const translated = this.i18n.t(`cond.${cond}`);
    return translated === `cond.${cond}` ? cond : translated;
  }

  isOwnListing(item: { seller?: string | number } | null): boolean {
    return isOwnListing(item?.seller, this.auth.user()?.id);
  }

  contactSeller(listingId: string) {
    if (!this.auth.isLoggedIn()) {
      this.router.navigate(this.regionLink.path(['/login']), { queryParams: { returnUrl: this.router.url } });
      return;
    }

    if (!this.isVerified) {
      this.showUnverifiedPrompt = true;
      this.cdr.markForCheck();
      return;
    }

    // The messages page opens the chat for this listing, and only creates
    // the conversation once the buyer sends something (see PendingChatStore).
    this.ga.trackContactSeller(listingId);
    this.router.navigate(this.regionLink.path(['/messages']), { queryParams: { listing: listingId } });
  }

  openListing(listingId: string) { // navigate to listing detail
    this.router.navigate(this.regionLink.path(['/listing', listingId]));
  }

  buyNow(listingId: string) {
    if (!this.auth.isLoggedIn()) {
      this.router.navigate(this.regionLink.path(['/login']), { queryParams: { returnUrl: this.router.url } });
      return;
    }
    this.router.navigate(this.regionLink.path(['/checkout', listingId]));
  }

  subscribeBook() {
    if (!this.auth.isLoggedIn()) {
      this.toast.info(this.i18n.t('alert.loginToSubscribe'));
      this.router.navigate(this.regionLink.path(['/login']));
      return;
    }
    if (this.bookId) {
      this.bookService.subscribe(this.bookId).subscribe({
        next: (res) => {
          this.ga.trackRequestBook(this.bookId, 'book');
          this.toast.success(this.i18n.t('alert.subscribed'));
          if (this.book) {
            this.book.waiting_count++;
            this.book.is_subscribed = true;
            this.book.subscription_id = res.id;
            this.cdr.markForCheck();
          }
        },
        error: () => this.toast.error(this.i18n.t('alert.subscribeFailed'))
      });
    }
  }

  unsubscribeBook() {
    if (this.book && this.book.subscription_id) {
      this.bookService.unsubscribe(this.book.subscription_id).subscribe({
        next: () => {
          this.toast.success(this.i18n.t('alert.unsubscribed'));
          this.book.waiting_count--;
          this.book.is_subscribed = false;
          this.book.subscription_id = null;
          this.cdr.markForCheck();
        },
        error: () => this.toast.error(this.i18n.t('alert.unsubscribeFailed'))
      });
    }
  }
}
