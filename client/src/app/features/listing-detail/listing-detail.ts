import { onLanguageChange } from '../../core/on-language-change';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, effect, ViewChild, ElementRef, PLATFORM_ID, NgZone, untracked } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ListingService } from '../../core/services/listing.service';
import { BookService } from '../../core/services/book.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiBackButton } from '../../shared/ui/back-button.component';
import { UiBreadcrumb, BreadcrumbItem } from '../../shared/ui/breadcrumb.component';
import { UiListingCard } from '../../shared/ui/listing-card.component';
import { UiSellerReputation } from '../../shared/ui/seller-reputation.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { BookCoverPipe } from '../../shared/pipes/book-cover.pipe';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { UiActionBar } from '../../shared/ui/action-bar.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { AccountService } from '../../core/services/account.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { ReportModalComponent } from './report-modal.component';
import { UiVerificationPrompt } from '../../shared/ui/verification-prompt.component';
import { RegionLinkService } from '../../core/region-link.service';
import { RegionService } from '../../core/region.service';
import { isSameRegion } from '../../core/region-path';
import { scrollBehavior } from '../../core/reduced-motion';
import { isOwnListing } from '../../core/own-listing';
import { SeoService } from '../../core/services/seo.service';


@Component({
  selector: 'app-listing-detail',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, UiButton, UiActionBar, UiSkeleton, UiErrorState, UiEmpty, UiBackButton, UiBreadcrumb, UiListingCard, UiSellerReputation, TPipe, PricePipe, ReportModalComponent, UiVerificationPrompt],
  templateUrl: './listing-detail.html',
  styleUrls: ['./listing-detail.css']
})
export class ListingDetail implements OnInit, OnDestroy {
  @ViewChild('carouselTrack') carouselTrack?: ElementRef<HTMLDivElement>;

  listing: any = null;
  isLoading = true;
  errorMsg = '';
  /** The listing is gone (sold and deleted, or never existed) — a link from
   *  an old order or chat lands here. Not an error: say so and offer a way on. */
  notFound = false;
  showUnverifiedPrompt = false;
  
  allPhotos: string[] = [];
  selectedIndex: number = 0;
  otherListings: any[] = [];
  brokenPhotos = new Set<number>();

  /** Home › <book title>. The school/college category is deliberately left
   *  out: the listing payload carries only the category *slug*, and turning
   *  that into a readable name would cost a metadata request per page view. */
  get breadcrumbItems(): BreadcrumbItem[] {
    if (!this.listing) return [];
    return [
      { labelKey: 'nav.home', link: '/' },
      { label: this.listing.book_title }
    ];
  }

  /** A listing id is global, so `/hk/listing/<id>` loads a TW listing just as
   *  well as `/tw/listing/<id>` does — a hand-edited URL, or a link shared
   *  across regions. The page still shows it (in its own currency), but says
   *  so, and withholds the chat and meetup actions: both are region-scoped on
   *  the backend and would fail from here. */
  get regionMismatch(): boolean {
    return !!this.listing?.region && !isSameRegion(this.listing.region, this.regionService.region());
  }

  readonly currentRegion = () => this.regionService.region();

  regionName(code: string | null | undefined): string {
    if (!code) return '';
    const region = this.regionService.regions().find(r => isSameRegion(r.code, code));
    return region?.localized_name || code.toUpperCase();
  }

  switchToListingRegion() {
    if (this.listing?.region) {
      this.regionService.setRegion(this.listing.region);
    }
  }

  showReportModal = false;
  reportConfirmationMsg = '';
  private currentUserId: string | number | null = null;

  /** Scroll depth milestones already fired for the current listing. */
  private firedScrollThresholds = new Set<number>();
  private scrollHandler?: () => void;
  private readonly SCROLL_THRESHOLDS: Array<25 | 50 | 75 | 90> = [25, 50, 75, 90];

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private regionService = inject(RegionService);
  private listingService = inject(ListingService);
  private bookService = inject(BookService);
  private accountService = inject(AccountService);
  private cdr = inject(ChangeDetectorRef);
  private auth = inject(AuthStore);
  private platformId = inject(PLATFORM_ID);
  private ngZone = inject(NgZone);
  readonly i18n = inject(I18nService);
  private ga = inject(GoogleAnalyticsService);
  private seo = inject(SeoService);

  currentId: string | null = null;

  constructor() {
    // Re-fetch listing when language changes so that backend translated fields (e.g. school_name, course_name) update.
    onLanguageChange(this.i18n, () => {
      if (this.currentId) {
        this.loadListing(this.currentId);
      }
    });

    // Fetch the current user's profile (browser-side only) to determine
    // whether to hide the "report" button on the user's own listing.
    effect(() => {
      if (isPlatformBrowser(this.platformId) && this.auth.isLoggedIn()) {
        this.accountService.getMyProfile().subscribe({
          next: (profile) => {
            this.currentUserId = profile?.id ?? null;
            this.cdr.markForCheck();
          },
          error: () => {
            // If the profile fetch fails, stay conservative (don't show the
            // report button) rather than risk mistaking someone else's listing for the user's own.
          }
        });
      }
    });
  }

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      const newId = params.get('id');
      this.currentId = newId;
      if (newId) {
        // Another listing: never show the previous one beside its error.
        if (String(this.listing?.id) !== newId) this.listing = null;
        this.otherListings = [];
        this.firedScrollThresholds.clear(); // reset thresholds for new listing
        this.startLoad(newId);
      } else {
        this.isLoading = false;
        this.errorMsg = this.i18n.t('alert.bookNotFound');
        this.cdr.markForCheck();
      }
    });

    if (isPlatformBrowser(this.platformId)) {
      this.ngZone.runOutsideAngular(() => {
        this.scrollHandler = () => this.onWindowScroll();
        window.addEventListener('scroll', this.scrollHandler, { passive: true });
      });
    }
  }


  /** Load the listing with the skeleton up, and give up after 8s. Also the
   *  error state's retry. */
  startLoad(id: string) {
    this.isLoading = true;
    this.errorMsg = '';
    this.notFound = false;
    this.cdr.markForCheck();
    this.loadListing(id);
    // Fallback in case the API hangs. Running outside Angular's zone
    // so the timeout doesn't trigger unnecessary change detection.
    this.ngZone.runOutsideAngular(() => {
      setTimeout(() => {
        if (this.isLoading && this.currentId === id) {
          this.ngZone.run(() => {
            this.isLoading = false;
            this.errorMsg = this.i18n.t('alert.loadingTimeout');
            this.cdr.markForCheck();
          });
        }
      }, 8000);
    });
  }

  private loadListing(id: string) {
    this.listingService.getListing(id).subscribe({
      next: (data) => {
        this.listing = data;
        this.isLoading = false;
        // A late answer after the 8s timeout replaces its error.
        this.errorMsg = '';
        this.ga.trackViewItem({
          bookId: data.book,
          isbn: data.isbn,
          listingId: data.id,
          name: data.book_title,
          category: data.category_name,
          price: data.price,
          currency: data.currency
        });
        
        // Setup photos array (combine user uploaded photos + book cover)
        this.allPhotos = [];
        this.brokenPhotos = new Set<number>();
        if (data.photos && data.photos.length > 0) {
          this.allPhotos.push(...data.photos);
        }
        // Apply zoom=3 to Google Books cover for max resolution
        const coverUrl = data.book_cover_url
          ? new BookCoverPipe().transform(data.book_cover_url, 3)
          : null;
        if (coverUrl && !this.allPhotos.includes(coverUrl)) {
          this.allPhotos.push(coverUrl);
        }
        this.selectedIndex = 0;
        // Named after the book, pictured with the seller's first photo: that
        // is what a shared listing link should preview as.
        this.seo.setPage({ title: data.book_title, image: this.allPhotos[0] || undefined });

        // Fetch other listings for the same book — after the main listing loads.
        // Skipped for a listing from another region: the book lookup is
        // scoped to the page's region, so it would list that region's sellers
        // under a listing that belongs to neither them nor their currency.
        this.otherListings = [];
        const bookIdentifier = data.isbn || data.book;
        if (bookIdentifier && isPlatformBrowser(this.platformId) && !this.regionMismatch) {
          this.bookService.getBook(bookIdentifier).subscribe({
            next: (bookData) => {
              if (bookData && bookData.listings) {
                const listingsArray = Array.isArray(bookData.listings) 
                  ? bookData.listings 
                  : bookData.listings.results || [];
                this.otherListings = listingsArray.filter((l: any) => l.id !== this.listing.id);
                this.cdr.markForCheck();
              }
            }
          });
        }

        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        // A language switch reloads a listing already on screen; keep it.
        if (this.listing && String(this.listing.id) === id) {
          this.cdr.markForCheck();
          return;
        }
        if (err?.status === 404) {
          this.notFound = true;
        } else {
          // Not a 404: the listing may well exist; offer the retry.
          this.errorMsg = this.i18n.t('common.loadFailed');
        }
        this.cdr.markForCheck();
      }
    });
  }

  goSearch() {
    this.router.navigate(this.regionLink.path(['/search']));
  }

  /** Both checkout entrances and contactSeller() share this gate. Only
   *  contactSeller() used to run the verification half of it: the two buy
   *  paths sent an unverified buyer all the way into /checkout to be refused
   *  there, instead of showing the prompt that says what to do about it. */
  private canStartTransaction(): boolean {
    if (!this.auth.isLoggedIn()) {
      this.router.navigate(this.regionLink.path(['/login']), { queryParams: { returnUrl: this.router.url } });
      return false;
    }
    const user = this.auth.getUser();
    if (user && this.listing && !this.auth.isVerifiedIn(this.listing?.region)) {
      this.showUnverifiedPrompt = true;
      this.cdr.markForCheck();
      return false;
    }
    return true;
  }

  buyNow() {
    if (!this.canStartTransaction()) return;
    if (this.listing?.id) {
      this.ga.trackEvent('click_buy_now', { item_id: this.listing.id });
      this.router.navigate(this.regionLink.path(['/checkout', this.listing.id]));
    }
  }

  buyNowOther(id: string) {
    if (!this.canStartTransaction()) return;
    this.router.navigate(this.regionLink.path(['/checkout', id]));
  }

  contactSeller() {
    if (!this.canStartTransaction()) return;
    if (this.listing?.id) {
      this.ga.trackContactSeller(this.listing.id);
      this.router.navigate(this.regionLink.path(['/messages']), { queryParams: { listing: this.listing.id } });
    }
  }

  contactSellerOther(id: string) {
    this.goToListing(id);
  }

  selectPhoto(index: number) {
    if (!this.carouselTrack) return;
    const el = this.carouselTrack.nativeElement;
    el.scrollTo({ left: el.clientWidth * index, behavior: scrollBehavior() });
  }

  scrollGallery(direction: number) {
    if (!this.carouselTrack) return;
    const el = this.carouselTrack.nativeElement;
    const scrollAmount = el.clientWidth;
    el.scrollBy({ left: scrollAmount * direction, behavior: scrollBehavior() });
  }

  onScroll() {
    if (!this.carouselTrack) return;
    const el = this.carouselTrack.nativeElement;
    const index = Math.round(el.scrollLeft / el.clientWidth);
    if (this.selectedIndex !== index) {
      this.selectedIndex = index;
      this.cdr.detectChanges();
    }
  }

  onImageError(index: number) {
    if (!this.brokenPhotos.has(index)) {
      this.brokenPhotos.add(index);
      this.cdr.markForCheck();
    }
  }

  goToListing(id: string) {
    this.router.navigate(this.regionLink.path(['/listing', id]));
  }

  isOwnListing(item: { seller?: string | number } | null): boolean {
    return isOwnListing(item?.seller, this.auth.user()?.id);
  }

  // Only show the report button when logged in and the listing isn't the user's own.
  canReport(): boolean {
    if (!this.listing || !this.auth.isLoggedIn() || this.currentUserId === null) {
      return false;
    }
    return String(this.listing.seller) !== String(this.currentUserId);
  }

  openReportModal() {
    this.reportConfirmationMsg = '';
    this.showReportModal = true;
  }

  closeReportModal() {
    this.showReportModal = false;
  }

  onReportSubmitted() {
    this.showReportModal = false;
    if (this.listing?.id) {
      this.ga.trackEvent('report_listing', { item_id: this.listing.id });
    }
    this.reportConfirmationMsg = this.i18n.t('moderation.reportSubmitted');
    this.cdr.markForCheck();
  }

  trackById(index: number, item: any): any {
    return item.id || index;
  }

  /** Track scroll depth milestones for listing-detail pages. */
  onWindowScroll(): void {
    if (!isPlatformBrowser(this.platformId) || this.isLoading) return;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    if (docHeight <= 0) return;
    const percent = Math.floor((scrollTop / docHeight) * 100);
    for (const threshold of this.SCROLL_THRESHOLDS) {
      if (percent >= threshold && !this.firedScrollThresholds.has(threshold)) {
        this.firedScrollThresholds.add(threshold);
        this.ga.trackScrollDepth(threshold);
      }
    }
  }

  ngOnDestroy(): void {
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = undefined;
    }
    this.firedScrollThresholds.clear();
  }
}
