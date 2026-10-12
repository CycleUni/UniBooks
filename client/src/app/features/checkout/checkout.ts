import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
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


@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, UiButton, UiActionBar, UiSkeleton, UiErrorState, UiEmpty, UiBookCover, TPipe, PricePipe],
  template: `
      <main class="container container--form checkout-page">
        <h2>{{ 'checkout.title' | t }}</h2>

        <!-- Shaped like the two cards below: a cover beside the title, then
             the form. -->
        <ng-container *ngIf="isLoading">
          <ui-skeleton variant="list" [count]="1"></ui-skeleton>
          <ui-skeleton variant="report" [count]="1"></ui-skeleton>
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

        <div *ngIf="!isLoading && listing" class="checkout-grid">
          <!-- Order Summary -->
          <div class="summary-card">
            <h3>{{ 'checkout.summary' | t }}</h3>
            <div class="book-info">
              <ui-book-cover
                class="book-cover"
                [coverUrl]="listing.photos?.length ? listing.photos[0] : listing.book_cover_url"
                [title]="listing.book_title"
                [author]="listing.book_authors"
              ></ui-book-cover>
              <div>
                <h4 class="book-title-serif">{{ listing.book_title }}</h4>
                <p class="muted" *ngIf="listing.book_authors">{{ listing.book_authors }}</p>
                <div class="price" #summaryPrice>{{ listing.price | price: listing.currency }}</div>
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
              <span actionBarLead>{{ listing.price | price: listing.currency }}</span>
              <ui-button block class="flex-1" (onClick)="placeOrder()" [disabled]="isSubmitting">
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
    .book-info {
      display: flex;
      gap: 16px;
      margin-top: 16px;
    }
    .book-info > div {
      flex: 1;
      min-width: 0;
    }
    .book-info h4 {
      margin: 0 0 4px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .book-info .muted {
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
    @media (max-width: 768px) {
      .checkout-grid {
        grid-template-columns: 1fr;
      }
    }
  `]
})
export class CheckoutComponent implements OnInit {
  listing: any = null;
  isLoading = true;
  /** The listing failed to load for a reason other than not existing. */
  loadFailed = false;
  /** No such listing (404). */
  notFound = false;
  isSubmitting = false;
  errorKey = '';
  errorMsg = '';
  isNoChatError = false;

  listingId: string | null = null;

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private listingService = inject(ListingService);
  private orderService = inject(OrderService);
  readonly i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private ga = inject(GoogleAnalyticsService);

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      const id = params.get('id');
      if (id) {
        this.listingId = id;
        this.loadListing();
      }
    });
  }

  loadListing() {
    this.listingService.getListing(this.listingId!).subscribe({
      next: (data) => {
        this.listing = data;
        this.isLoading = false;
        this.ga.trackBeginCheckout({
          listingId: data.id,
          bookId: data.book,
          isbn: data.isbn,
          itemName: data.book_title,
          price: data.price,
          currency: data.currency
        });
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

  retryLoad() {
    this.isLoading = true;
    this.loadFailed = false;
    this.loadListing();
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
    this.isSubmitting = true;
    this.errorMsg = '';
    this.isNoChatError = false;
    this.cdr.markForCheck();

    const orderData = {
      listing: this.listingId!
    };

    this.orderService.createOrder(orderData).subscribe({
      next: (order) => {
        // A request to the seller, not a sale: GA's purchase is sent when the
        // buyer confirms receipt (account/orders).
        this.ga.trackPlaceOrder({
          ...order,
          listing_title: order.listing_title || this.listing?.book_title,
          total_amount: order.total_amount ?? this.listing?.price,
          currency: order.currency || this.listing?.currency,
        });
        this.router.navigate(this.regionLink.path(['/checkout/success']));
      },
      error: (err) => {
        this.isSubmitting = false;
        this.errorKey = '';
        this.errorMsg = '';
        this.isNoChatError = false;
        const errStr = JSON.stringify(err.error || {});
        if (errStr.includes('checkout.errNoChat')) {
          this.errorKey = 'checkout.errNoChat';
          this.isNoChatError = true;
        } else if (errStr.includes('checkout.errListingUnavailable')) {
          this.errorKey = 'checkout.errListingUnavailable';
        } else {
          // If it's a standard DRF error object, try to extract the first string
          let msg = 'checkout.orderFailed';
          let foundBackendMsg = false;
          if (err.error && typeof err.error === 'object') {
            for (const key in err.error) {
              if (Array.isArray(err.error[key]) && err.error[key].length > 0) {
                msg = err.error[key][0];
                foundBackendMsg = true;
                break;
              }
            }
          }
          if (foundBackendMsg) {
            // Check if the extracted message is an i18n key
            if (typeof msg === 'string' && msg.startsWith('checkout.')) {
              this.errorKey = msg;
            } else {
              this.errorMsg = msg;
            }
          } else {
            this.errorKey = msg;
          }
        }
        this.cdr.markForCheck();
      }
    });
  }

  contactSeller() {
    if (!this.listingId) return;
    this.ga.trackEvent('checkout_to_chat', { listing_id: this.listingId });
    // As on the listing page: the conversation is created by the first
    // message, not by opening the chat.
    this.router.navigate(this.regionLink.path(['/messages']), { queryParams: { listing: this.listingId } });
  }
}
