import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiBookCover } from '../../shared/ui/book-cover.component';
import { ListingService } from '../../core/services/listing.service';
import { OrderService } from '../../core/services/order.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { UiActionBar } from '../../shared/ui/action-bar.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { RegionLinkService } from '../../core/region-link.service';
import { translateApiError } from '../../core/api-error.util';


@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, UiButton, UiActionBar, UiSkeleton, UiErrorState, UiEmpty, UiBookCover, TPipe, PricePipe],
  template: `
      <main class="container container--form checkout-page" data-clarity-mask="True">
        <h2>{{ 'checkout.title' | t }}</h2>

        <!-- Shaped like the two cards below: a cover beside the title, then
             the form. -->
        <ng-container *ngIf="isLoading">
          <ui-skeleton variant="checkout"></ui-skeleton>
        </ng-container>

        <!-- The order form lives inside the grid below, so a failed load
             used to leave this page as a bare title. -->
        <ui-error-state *ngIf="!isLoading && loadFailed" [message]="'common.loadFailed' | t" (retry)="retryLoad()"></ui-error-state>
        <ui-empty
          *ngIf="!isLoading && notFound"
          [message]="'listing.notFoundTitle' | t"
          [description]="'listing.notFoundBody' | t"
          [actionText]="'listing.notFoundAction' | t"
          (onAction)="goSearch()"
        ></ui-empty>

        <div *ngIf="!isLoading && (listing || listings.length > 0)" class="checkout-grid">
          <!-- Order Summary -->
          <div class="summary-card">
            <h3>{{ 'checkout.summary' | t }}</h3>

            <div class="items-list">
              <div
                class="checkout-item"
                *ngFor="let item of listings; trackBy: trackByItem"
                [class.item-refused]="!!refusedListingErrors[item.id]"
              >
                <div class="book-info">
                  <ui-book-cover
                    class="book-cover"
                    [coverUrl]="item.photos?.length ? item.photos[0] : item.book_cover_url"
                    [title]="item.book_title"
                    [author]="item.book_authors"
                  ></ui-book-cover>
                  <div class="item-details">
                    <h4 class="book-title-serif">{{ item.book_title }}</h4>
                    <p class="muted" *ngIf="item.book_authors">{{ item.book_authors }}</p>
                    <div class="price" *ngIf="listings.length > 1">{{ item.price | price: item.currency }}</div>
                    <div class="inline-msg error item-err" *ngIf="refusedListingErrors[item.id]">
                      {{ refusedListingErrors[item.id] | t }}
                    </div>
                  </div>
                  <button
                    *ngIf="listings.length > 1"
                    type="button"
                    class="item-remove-btn"
                    [title]="'checkout.removeItem' | t"
                    [attr.aria-label]="'checkout.removeItem' | t"
                    (click)="removeItem(item)"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>

            <div class="summary-total-container" #summaryPrice>
              <div class="total-row" *ngIf="listings.length > 1">
                <span class="total-label">{{ 'checkout.total' | t }}</span>
                <div class="price total-price">{{ totalPrice | price: currency }}</div>
              </div>
              <div class="price single-price" *ngIf="listings.length === 1">
                {{ totalPrice | price: currency }}
              </div>
            </div>
          </div>

          <!-- Checkout Form -->
          <div class="form-card">
            <h3>{{ 'checkout.meetupFormTitle' | t }}</h3>
            <p class="muted mb-5" >
              {{ 'checkout.meetupFormDesc' | t }}
            </p>

            <div *ngIf="errorKey || errorMsg" class="inline-msg error">
              {{ errorKey ? (errorKey | t) : errorMsg }}
              <div *ngIf="isNoChatError"  class="mt-4">
                <ui-button variant="white"  block style="display: block;" (onClick)="contactSeller()">{{ 'book.contactSeller' | t }}</ui-button>
              </div>
            </div>

            <ui-action-bar class="mt-5" [leadFor]="summaryPrice">
              <span actionBarLead>{{ totalPrice | price: currency }}</span>
              <ui-button block class="flex-1" (onClick)="placeOrder()" [disabled]="isSubmitting || (listings.length === 0 && !listingId)">
                {{ (isSubmitting ? 'checkout.processing' : 'checkout.sendMeetupRequest') | t }}
              </ui-button>
            </ui-action-bar>
          </div>
        </div>
      </main>
  `,
  styles: [`
    /* Width comes from .container--form; this class only carries the page's
       vertical rhythm. The old rule redeclared .container at 800px *and*
       omitted padding-inline, so on a phone the address fields and the price
       ran flush into both screen edges — on the one page that takes payment
       details. */
    .checkout-page {
      margin-block: var(--space-6);
    }
    .checkout-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }
    .summary-card, .form-card {
      background: var(--surface-card);
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .items-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-top: 16px;
    }
    .checkout-item {
      position: relative;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .checkout-item:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .checkout-item.item-refused {
      border: 1px solid var(--danger);
      background-color: var(--danger-light);
      border-radius: var(--radius-sm);
      padding: 8px;
    }
    .item-err {
      margin-top: 6px;
      font-size: var(--text-xs);
    }
    .book-info {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }
    .item-details {
      flex: 1;
      min-width: 0;
    }
    .item-details h4 {
      margin: 0 0 4px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .item-details .muted {
      margin: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .book-cover {
      width: 80px;
      height: 120px;
      flex-shrink: 0;
      border: 1px solid var(--line);
      border-radius: 4px;
      overflow: hidden;
    }
    .price {
      font-size: var(--text-xl);
      font-weight: 700;
      color: var(--accent);
      margin-top: 8px;
    }
    .item-remove-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--muted);
      border-radius: 50%;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      transition: color var(--motion-fast), background var(--motion-fast);
      flex-shrink: 0;
    }
    .item-remove-btn:hover {
      background: var(--danger-light);
      color: var(--danger);
    }
    .summary-total-container {
      margin-top: 16px;
    }
    .total-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 16px;
      border-top: 2px solid var(--line-strong);
    }
    .total-label {
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--ink);
    }
    .total-price {
      margin-top: 0;
    }
    .single-price {
      margin-top: 8px;
    }
    @media (max-width: 768px) {
      .checkout-grid {
        grid-template-columns: 1fr;
      }
    }
  `]
})
export class CheckoutComponent implements OnInit {
  listings: any[] = [];
  get listing(): any {
    return this.listings[0] || null;
  }
  set listing(val: any) {
    if (val) {
      if (this.listings.length === 0) {
        this.listings = [val];
      } else {
        this.listings[0] = val;
      }
    } else {
      this.listings = [];
    }
  }

  conversationId: string | null = null;
  isLoading = true;
  /** The listing failed to load for a reason other than not existing. */
  loadFailed = false;
  /** No such listing (404). */
  notFound = false;
  isSubmitting = false;
  errorKey = '';
  errorMsg = '';
  isNoChatError = false;
  refusedListingErrors: Record<string, string> = {};

  listingId: string | null = null;
  listingIds: string[] = [];

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private listingService = inject(ListingService);
  private orderService = inject(OrderService);
  readonly i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private ga = inject(GoogleAnalyticsService);

  get totalPrice(): number {
    if (this.listings.length === 0) return this.listing?.price || 0;
    return this.listings.reduce((sum, item) => sum + (item?.price || 0), 0);
  }

  get currency(): string {
    return this.listings[0]?.currency || this.listing?.currency || 'TWD';
  }

  trackByItem(_: number, item: any): string {
    return item?.id || '';
  }

  ngOnInit() {
    this.route.paramMap?.subscribe(params => {
      const id = params.get('id');
      if (id) {
        this.listingId = id;
        this.listingIds = [id];
      }
    });

    if (this.route.queryParamMap) {
      this.route.queryParamMap.subscribe(queryParams => {
        const chat = queryParams.get('chat');
        if (chat) this.conversationId = chat;

        const rawListings = queryParams.get('listings');
        if (rawListings) {
          const ids = rawListings.split(',').map(s => s.trim()).filter(Boolean);
          if (ids.length > 0) {
            this.listingIds = ids;
            this.listingId = ids[0];
          }
        }
        this.loadListings();
      });
    } else {
      this.loadListings();
    }
  }

  loadListings() {
    const ids = this.listingIds.length > 0 ? this.listingIds : (this.listingId ? [this.listingId] : []);
    if (!ids.length) {
      this.isLoading = false;
      this.notFound = true;
      this.cdr.markForCheck();
      return;
    }

    this.isLoading = true;
    this.loadFailed = false;
    this.notFound = false;

    const requests = ids.map(id => this.listingService.getListing(id));
    forkJoin(requests).subscribe({
      next: (dataList) => {
        this.listings = dataList;
        this.isLoading = false;
        for (const data of dataList) {
          this.ga.trackBeginCheckout({
            listingId: data.id,
            bookId: data.book,
            isbn: data.isbn,
            itemName: data.book_title,
            price: data.price,
            currency: data.currency
          });
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        if (err?.status === 404) this.notFound = true;
        else this.loadFailed = true;
        this.cdr.markForCheck();
      }
    });
  }

  loadListing() {
    this.loadListings();
  }

  removeItem(item: any) {
    if (this.listings.length <= 1) return;
    this.listings = this.listings.filter(l => l.id !== item.id);
    this.listingIds = this.listings.map(l => l.id);
    if (this.refusedListingErrors[item.id]) {
      delete this.refusedListingErrors[item.id];
    }
    if (Object.keys(this.refusedListingErrors).length === 0) {
      if (this.errorKey === 'checkout.itemsUnavailableHint') {
        this.errorKey = '';
      }
    }
    this.cdr.markForCheck();
  }

  retryLoad() {
    this.isLoading = true;
    this.loadFailed = false;
    this.loadListings();
  }

  goSearch() {
    this.router.navigate(this.regionLink.path(['/search']));
  }

  onFormChange() {
    if (this.errorMsg) {
      this.errorMsg = '';
      this.isNoChatError = false;
      this.cdr.markForCheck();
    }
  }

  async placeOrder() {
    // The button is disabled while submitting; Enter or a fast second tap is not.
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    this.errorMsg = '';
    this.errorKey = '';
    this.isNoChatError = false;
    this.cdr.markForCheck();

    let orderData: any;
    if (this.listings.length > 1) {
      orderData = {
        listing_ids: this.listings.map(l => l.id),
        conversation_id: this.conversationId || undefined,
      };
    } else {
      const singleId = this.listings[0]?.id || this.listingId!;
      orderData = {
        listing: singleId,
        conversation_id: this.conversationId || undefined,
      };
    }

    this.orderService.createOrder(orderData).subscribe({
      next: (order) => {
        // A request to the seller, not a sale: GA's purchase is sent when the
        // buyer confirms receipt (account/orders).
        this.ga.trackPlaceOrder({
          ...order,
          listing_title: order.listing_title || this.listing?.book_title,
          total_amount: order.total_amount ?? this.totalPrice,
          currency: order.currency || this.currency,
        });
        this.router.navigate(this.regionLink.path(['/checkout/success']));
      },
      error: (err) => {
        this.isSubmitting = false;
        this.errorKey = '';
        this.errorMsg = '';
        this.isNoChatError = false;

        // Check for field errors naming listings
        const fields = err?.error?.error?.fields;
        this.refusedListingErrors = {};
        let hasItemErrors = false;
        if (fields && typeof fields === 'object') {
          for (const [key, val] of Object.entries(fields)) {
            if (this.listings.some(l => l.id === key)) {
              const code = Array.isArray(val) ? val[0] : String(val);
              this.refusedListingErrors[key] = code;
              hasItemErrors = true;
            }
          }
        }

        if (hasItemErrors) {
          this.errorKey = 'checkout.itemsUnavailableHint';
        } else if (err?.error?.error?.code === 'checkout.errNoChat') {
          this.errorKey = 'checkout.errNoChat';
          this.isNoChatError = true;
        } else {
          const translated = translateApiError(err, this.i18n);
          if (translated) this.errorMsg = translated;
          else this.errorKey = 'checkout.orderFailed';
        }
        this.cdr.markForCheck();
      }
    });
  }

  contactSeller() {
    const targetId = this.listings[0]?.id || this.listingId;
    if (!targetId) return;
    this.ga.trackEvent('checkout_to_chat', { listing_id: targetId });
    if (this.conversationId) {
      this.router.navigate(this.regionLink.path(['/messages']), { queryParams: { chat: this.conversationId } });
    } else {
      this.router.navigate(this.regionLink.path(['/messages']), { queryParams: { listing: targetId } });
    }
  }
}
