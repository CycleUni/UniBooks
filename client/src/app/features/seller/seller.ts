import { onLanguageChange } from '../../core/on-language-change';
import { Component, OnInit, inject, ChangeDetectorRef, effect, untracked, DestroyRef } from '@angular/core';
import { Subscription, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { SeoService } from '../../core/services/seo.service';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { RegionService } from '../../core/region.service';

import { AccountService } from '../../core/services/account.service';
import { ListingService } from '../../core/services/listing.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiListingRow } from '../../shared/ui/listing-row.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiInfiniteScroll } from '../../shared/ui/infinite-scroll.component';
import { injectIsPhone } from '../../core/viewport';
import { PhonePager } from '../../core/phone-pager';
import { UiBreadcrumb, BreadcrumbItem } from '../../shared/ui/breadcrumb.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { RegionLinkService } from '../../core/region-link.service';
import { isSameRegion } from '../../core/region-path';
import { isUserVerifiedIn } from '../../core/verification';

@Component({
  selector: 'app-seller-page',
  standalone: true,
  imports: [CommonModule, UiSkeleton, UiErrorState, UiListingRow, UiPagination, UiInfiniteScroll, UiBreadcrumb, TPipe],
  template: `
    <!-- The profile request gates the whole page; hold its place instead of
         rendering nothing and then snapping the header in. -->
    <div class="container container--narrow seller-page" *ngIf="!seller && !error && !loadFailed">
      <ui-skeleton variant="row" [count]="1"></ui-skeleton>
      <ui-skeleton [count]="5"></ui-skeleton>
    </div>

    <div class="container container--narrow seller-page" *ngIf="seller">
      <ui-breadcrumb [items]="breadcrumbItems"></ui-breadcrumb>

      <div class="seller-header">
        <div class="seller-avatar" *ngIf="!avatarUrl">
          {{ getAvatarInitial() }}
        </div>
        <div class="seller-avatar-image-container" *ngIf="avatarUrl">
          <img [src]="avatarUrl" [attr.alt]="seller.display_name ? (seller.display_name + ' ' + ('acct.avatarAlt' | t)) : ('acct.avatarAlt' | t)" class="seller-avatar-image" referrerpolicy="no-referrer">
        </div>
        <div class="seller-info">
          <h1 class="seller-name">{{ seller.display_name }}</h1>
          <div class="seller-meta">
            <span class="seller-school">
              {{ seller.school_name }}
              <span class="verified-badge" *ngIf="isSellerVerified()" [title]="'seller.verifiedBadge' | t">✓</span>
            </span>
            <span class="seller-joined">
              {{ 'seller.joined' | t }}{{ getFormattedDate(seller.created_at) }}
            </span>
          </div>
          <div class="seller-stats mt-2"  style="font-size: var(--text-base); color: var(--ink); display: flex; gap: 16px;">
            <span *ngIf="seller.review_count > 0">⭐️ {{ seller.average_rating }} ({{ seller.review_count }})</span>
            <span *ngIf="seller.review_count === 0" class="muted">{{ 'seller.noReviews' | t }}</span>
            <span *ngIf="seller.no_show_count > 0" style="color: var(--flag); font-weight: 500;">⚠️ {{ 'seller.noShowCount' | t:{n: seller.no_show_count} }}</span>
          </div>
        </div>
      </div>

      <div class="seller-listings">
        <h2>{{ 'seller.listingsTitle' | t:{name: seller.display_name} }}</h2>
        
        <div class="listings-grid" *ngIf="!loadingListings && !listingsFailed && listings.length > 0">
          <ui-listing-row
            *ngFor="let listing of listings"
            [title]="listing.book_title || listing.book?.title"
            [metaInfo]="listing.book_authors || listing.book?.authors || ''"
            [courseInfo]="getCourseOrNoteInfo(listing)"
            [noteInfo]="listing.description ? (('sell.note' | t) + ': ' + listing.description) : undefined"
            [price]="listing.price"
            [coverUrl]="(listing.photos && listing.photos.length > 0) ? listing.photos[0] : (listing.book_cover_url || listing.book?.cover_url)"
            [condition]="listing.condition"
            [waitlistCount]="listing.waitlist_count"
            (click)="goToListing(listing.id)"
          ></ui-listing-row>
        </div>
        
        <ui-pagination *ngIf="!isPhone && totalListings > 20" [total]="totalListings" [pageSize]="20" [currentPage]="currentPage" (pageChange)="onPageChange($event)"></ui-pagination>
        <ui-infinite-scroll *ngIf="isPhone && !loadingListings && !listingsFailed && listings.length > 0" [loading]="loadingMore" [hasMore]="hasMoreListings" [error]="loadMoreError" (loadMore)="onLoadMore()"></ui-infinite-scroll>

        <ui-error-state
          *ngIf="!loadingListings && listingsFailed"
          [message]="'seller.listingsLoadFailed' | t"
          (retry)="currentId && loadListings(currentId)"
        ></ui-error-state>

        <div class="empty-state" *ngIf="!loadingListings && !listingsFailed && listings.length === 0">
          <p>{{ 'seller.noListings' | t }}</p>
        </div>
        
        <ui-skeleton *ngIf="loadingListings" [count]="5"></ui-skeleton>
      </div>
    </div>
    
    <!-- Only a 404 means there is no such seller; anything else is a load
         that failed and may well work on a second try. -->
    <div class="container container--narrow seller-page" *ngIf="loadFailed">
      <ui-error-state [message]="'common.loadFailed' | t" (retry)="currentId && loadSeller(currentId)"></ui-error-state>
    </div>

    <div class="not-found" *ngIf="error">
      <h2>{{ 'seller.notFound' | t }}</h2>
      <p>{{ 'seller.notFoundDesc' | t }}</p>
      <button (click)="goHome()">{{ 'checkout.backHome' | t }}</button>
    </div>
  `,
  styles: [`
    /* Width comes from .container--narrow: a seller profile is one subject
       plus its listings, the same shape as a book or a listing page. */
    .seller-page {
      padding-block: var(--space-5);
    }
    
    .seller-header {
      display: flex;
      align-items: center;
      gap: 24px;
      background: var(--paper-warm);
      border: 1px solid var(--line);
      padding: 32px;
      border-radius: 12px;
      margin-bottom: 32px;
    }

    .seller-avatar {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background-color: var(--accent);
      color: var(--on-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-2xl);
      font-weight: 700;
    }
    .seller-avatar-image-container {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      overflow: hidden;
    }
    .seller-avatar-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .seller-name {
      margin: 0 0 8px 0;
      font-size: var(--text-3xl);
      font-weight: 700;
      color: var(--ink);
    }

    .seller-meta {
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: var(--muted);
      font-size: var(--text-base);
    }

    .seller-school {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .verified-badge {
      background: var(--success);
      color: var(--on-success);
      border-radius: 50%;
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-xs);
      margin-left: 4px;
    }

    .seller-listings h2 {
      font-size: var(--text-xl);
      font-weight: 600;
      margin-bottom: 20px;
      color: var(--ink);
    }

    .listings-grid {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .empty-state, .loading, .not-found {
      text-align: center;
      padding: 60px 20px;
      color: var(--muted);
    }
    
    .not-found button {
      margin-top: 16px;
      padding: 8px 24px;
      border: none;
      border-radius: 20px;
      background: var(--accent);
      color: var(--on-accent);
      cursor: pointer;
    }
  `]
})
export class SellerPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private accountService = inject(AccountService);
  private listingService = inject(ListingService);
  private seo = inject(SeoService);
  public regionService = inject(RegionService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private destroyRef = inject(DestroyRef);

  seller: any = null;
  listings: any[] = [];
  // Starts true: the profile renders first, and in that gap the listings are
  // still on their way, not absent.
  loadingListings = true;
  /** No such seller (404). */
  error = false;
  /** The profile failed to load for another reason; a retry may work. */
  loadFailed = false;
  /** The listings failed to load: not the same as having none. */
  listingsFailed = false;
  totalListings = 0;
  currentPage = 1;
  private isPhoneSignal = injectIsPhone();
  get isPhone(): boolean { return this.isPhoneSignal(); }
  set isPhone(v: boolean) { this.isPhoneSignal.set(v); }

  readonly pager = new PhonePager<any>({
    fetchPage: (page) => {
      if (!this.currentId) {
        return of({ items: [], total: this.totalListings });
      }
      return this.listingService.getListings(undefined, this.currentId, page).pipe(
        map((data: any) => {
          let items: any[] = [];
          let total = this.totalListings;
          if (data.results) {
            items = data.results;
            total = data.count || total;
          } else {
            items = data || [];
          }
          return { items, total };
        })
      );
    },
    onAppend: (items) => {
      this.listings = [...this.listings, ...items];
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
  averageRating = 0;
  reviewCount = 0;
  noShowCount = 0;
  avatarUrl = '';
  
  currentId: string | null = null;

  /** Home › <seller name>. */
  get breadcrumbItems(): BreadcrumbItem[] {
    if (!this.seller) return [];
    return [
      { labelKey: 'nav.home', link: '/' },
      { label: this.seller.display_name }
    ];
  }

  constructor() {
    onLanguageChange(this.i18n, () => {
      if (this.currentId) {
        this.loadSeller(this.currentId);
      }
    });
  }

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      const id = params.get('id');
      const pageParam = Math.max(1, Number(this.route.snapshot?.queryParamMap?.get('page')) || 1);
      // Lists always start at page 1 on phone, ignoring ?page without rewriting the URL
      this.currentPage = this.isPhone ? 1 : pageParam;
      if (id !== this.currentId) {
        // Another seller: show the skeleton, not the previous seller's page.
        this.seller = null;
        this.listings = [];
        this.loadingListings = true;
        this.error = false;
        this.loadFailed = false;
        this.pager.reset(this.currentPage, 0);
      }
      this.currentId = id;
      if (id) {
        this.loadSeller(id);
      }
    });
  }

  loadSeller(id: string) {
    this.loadFailed = false;
    this.accountService.getPublicUserProfile(id).subscribe({
      next: (profile) => {
        this.seller = profile;
        this.averageRating = profile.average_rating || 0;
        this.reviewCount = profile.review_count || 0;
        this.noShowCount = profile.no_show_count || 0;
        this.avatarUrl = profile.avatar_url || '';
        // A key, not a resolved string, so a language switch re-titles the tab.
        this.seo.setPage({ titleKey: 'seller.pageTitle', titleParams: { name: this.seller.display_name } });
        this.cdr.detectChanges();
        this.loadListings(id);
      },
      error: (err) => {
        // A language switch reloads a seller already on screen; keep it.
        if (!this.seller) {
          if (err?.status === 404) this.error = true;
          else this.loadFailed = true;
        }
        this.cdr.detectChanges();
      }
    });
  }

  loadListings(sellerId: string) {
    this.loadingListings = true;
    this.listingsFailed = false;
    this.pager.reset(this.currentPage, this.totalListings);
    this.cdr.detectChanges();
    this.listingService.getListings(undefined, sellerId, this.currentPage).subscribe({
      next: (data: any) => {
        if (data.results) {
          this.listings = data.results;
          this.totalListings = data.count || this.listings.length;
        } else {
          this.listings = data || [];
          this.totalListings = this.listings.length;
        }
        this.pager.reset(this.currentPage, this.totalListings);
        this.loadingListings = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.loadingListings = false;
        this.listingsFailed = true;
        this.cdr.detectChanges();
      }
    });
  }

  onLoadMore() {
    this.pager.loadMore();
  }

  onPageChange(page: number) {
    this.currentPage = page;
    if (this.currentId) {
      this.loadListings(this.currentId);
    }
  }

  goToListing(id: string) {
    this.router.navigate(this.regionLink.path(['/listing', id]));
  }

  goHome() {
    this.router.navigate(this.regionLink.path(['/']));
  }

  isSellerVerified(): boolean {
    return isUserVerifiedIn(this.seller?.verifications, this.regionService.region());
  }

  getAvatarInitial(): string {
    const last = this.seller?.last_name || '';
    const first = this.seller?.first_name || '';
    if (/[A-Za-z]/.test(last) || /[A-Za-z]/.test(first)) {
      return (first.charAt(0) || last.charAt(0) || this.i18n.t('acct.avatarFallback')).toUpperCase();
    }
    return (last.charAt(0) || first.charAt(0) || this.i18n.t('acct.avatarFallback')).toUpperCase();
  }

  getFormattedDate(dateString: string): string {
    if (!dateString) return '';
    try {
      const date = new Date(dateString);
      const lang = this.i18n.lang() === 'zh-TW' ? 'zh-TW' : 'en-US';
      return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
    } catch (e) {
      return dateString.substring(0, 10);
    }
  }

  getCourseOrNoteInfo(listing: any): string {
    if (listing.course_name) {
      return `${this.i18n.t('sell.course')}: ${listing.course_name}`;
    }
    return '';
  }
}
