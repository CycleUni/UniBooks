import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { OrderService, Order } from '../../core/services/order.service';
import { AuthStore } from '../../core/auth.store';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AccountService } from '../../core/services/account.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { Router, ActivatedRoute } from '@angular/router';
import { ReviewModalComponent } from './review-modal.component';
import { MeetupDetailsService } from '../../core/services/meetup-details.service';
import { DateTimeFormatPipe } from '../../shared/pipes/datetime-format.pipe';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { RegionLinkService } from '../../core/region-link.service';
import { ToastService } from '../../core/services/toast.service';
import { scrollBehavior } from '../../core/reduced-motion';
import { parseApiError } from '../../core/api-error.util';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { UiPullToRefresh } from '../../shared/ui/pull-to-refresh.component';


@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [CommonModule, RouterModule, UiSkeleton, UiErrorState, TPipe, UiButton, UiEmpty, ReviewModalComponent, DateTimeFormatPipe, PricePipe, UiSearchBarComponent, RegionLinkDirective, UiPullToRefresh],
  template: `
    <ui-pull-to-refresh [refreshing]="refreshing" (refresh)="onRefresh()">
      <h2 class="section-heading">{{ 'acct.myOrders' | t }}</h2>

      <div class="tabs">
        <!-- Neither tab is marked until the first load has picked the side
             with the newest activity, or the user has picked one: marking
             the default and then moving the mark was a visible jump. -->
        <button class="tab" [class.active]="tabSettled && activeTab === 'buying'" (click)="setTab('buying')">{{ 'acct.buying' | t }}</button>
        <button class="tab" [class.active]="tabSettled && activeTab === 'selling'" (click)="setTab('selling')">{{ 'acct.selling' | t }}</button>
      </div>

      <ui-search-bar 
         class="mb-5" style="display: block;"
        [placeholder]="'acct.searchOrders' | t" 
        [value]="searchQuery" 
        (search)="onSearchQuery($event)">
      </ui-search-bar>

      <ui-skeleton *ngIf="isLoading" variant="order" [count]="3"></ui-skeleton>

      <!-- A failed load is not "no orders yet". -->
      <ui-error-state
        *ngIf="!isLoading && loadFailed"
        [message]="'acct.ordersLoadFailed' | t"
        (retry)="loadOrders()"
      ></ui-error-state>

      <div *ngIf="!isLoading && !loadFailed">
        <div *ngIf="activeTab === 'buying'">
          <ui-empty *ngIf="filteredBoughtOrders.length === 0" [message]="'acct.noOrders' | t"></ui-empty>
          <div class="order-card" *ngFor="let order of filteredBoughtOrders" [id]="'order-' + order.id">
            <div *ngIf="hasExclusiveConflict(order)" class="exclusive-conflict">
              {{ 'order.exclusiveConflict' | t }}
              <ui-button variant="ghost" (onClick)="cancelOtherPending(order)">{{ 'order.cancelOtherPending' | t }}</ui-button>
            </div>
            <ng-container *ngTemplateOutlet="orderSummary; context: { $implicit: order, role: 'buyer' }"></ng-container>
            <div class="order-actions" *ngIf="hasActions(order, 'buyer')">
              <ui-button *ngIf="order.status === 'pending' || order.status === 'accepted'" variant="ghost" (onClick)="updateStatus(order, 'cancelled', 'buyer_cancelled')">{{ 'order.cancel' | t }}</ui-button>
              <ui-button *ngIf="order.status === 'handed_over'" (onClick)="updateStatus(order, 'completed')">{{ 'order.confirmReceived' | t }}</ui-button>
              <ui-button *ngIf="order.status === 'completed' && !order.has_reviewed" variant="ghost" (onClick)="openReviewModal(order)">{{ 'order.reviewAndReport' | t }}</ui-button>
            </div>
          </div>
        </div>

        <div *ngIf="activeTab === 'selling'">
          <ui-empty *ngIf="filteredSoldOrders.length === 0" [message]="'acct.noSales' | t"></ui-empty>
          <div class="order-card" *ngFor="let order of filteredSoldOrders" [id]="'order-' + order.id">
            <ng-container *ngTemplateOutlet="orderSummary; context: { $implicit: order, role: 'seller' }"></ng-container>
            <div class="order-actions" *ngIf="hasActions(order, 'seller')">
              <ng-container *ngIf="order.status === 'pending'">
                <ui-button (onClick)="approveOrder(order)">{{ 'order.approve' | t }}</ui-button>
                <ui-button variant="ghost" (onClick)="updateStatus(order, 'cancelled', 'seller_rejected')">{{ 'order.reject' | t }}</ui-button>
              </ng-container>
              <ui-button *ngIf="order.status === 'accepted'" (onClick)="updateStatus(order, 'handed_over')">{{ 'order.markHandedOver' | t }}</ui-button>
              <ui-button variant="ghost" *ngIf="order.status === 'accepted'" (onClick)="updateStatus(order, 'cancelled', 'seller_cancelled')">{{ 'order.cancel' | t }}</ui-button>
              <ui-button *ngIf="order.status === 'completed' && !order.has_reviewed" variant="ghost" (onClick)="openReviewModal(order)">{{ 'order.reviewAndReport' | t }}</ui-button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- One order's summary and expandable details, shared by both tabs.
           "role" is the viewer's side of the order: the row names the other
           party. -->
      <ng-template #orderSummary let-order let-role="role">
        <!-- The whole summary toggles the details for pointer users; the
             Details button below is the keyboard- and screen-reader path. -->
        <div class="order-summary" (click)="toggleDetails(order)">
          <div class="order-header">
            <!-- A full UUID as the row's heading was noise; the short form is
                 still unique enough to quote, and the full id is in the
                 details (and still matches the search box). -->
            <span class="order-meta">
              <span class="order-ref" [title]="order.id">#{{ shortRef(order.id) }}</span>
              <span *ngIf="order.created_at" class="order-date">
                <span aria-hidden="true"> · </span>
                <time [attr.datetime]="order.created_at">{{ order.created_at | date:'yyyy/MM/dd' }}</time>
              </span>
            </span>
            <span class="order-status badge" [ngClass]="order.status">
              {{ order.status === 'cancelled' && order.cancel_reason ? (cancelReasonKey(order.cancel_reason) | t) : (('order.status.' + order.status) | t) }}
            </span>
          </div>
          <div class="order-body">
            <div class="info">
              <h3 class="book-title-serif">
                {{ order.listing_title }}
                <span *ngIf="order.listing_deleted" class="deleted-tag">{{ 'common.listingDeleted' | t }}</span>
              </h3>
              <p class="party">
                <img *ngIf="partyAvatar(order, role)" [src]="partyAvatar(order, role)" alt="" class="party-avatar" referrerpolicy="no-referrer" />
                <span *ngIf="!partyAvatar(order, role)" class="party-avatar party-initial" aria-hidden="true">{{ partyName(order, role).charAt(0) }}</span>
                <span>
                  {{ (role === 'buyer' ? 'order.seller' : 'order.buyer') | t }}: {{ partyName(order, role) }}<!--
                  --><span *ngIf="partySchool(order, role)" class="party-school"> · {{ partySchool(order, role) }}</span>
                </span>
              </p>
              <p *ngIf="order.meetup_time" class="meetup-detail">{{ 'order.meetupTime' | t }}: {{ order.meetup_time | dateTimeFormat }}</p>
              <p *ngIf="order.meetup_location" class="meetup-detail">{{ 'order.meetupLocation' | t:{location: order.meetup_location} }}</p>
            </div>
            <div class="price">
              {{ order.total_amount | price: order.currency }}
            </div>
          </div>
        </div>

        <button
          type="button"
          class="details-toggle"
          [attr.aria-expanded]="isExpanded(order)"
          [attr.aria-controls]="'order-details-' + order.id"
          (click)="toggleDetails(order)"
        >{{ (isExpanded(order) ? 'order.hideDetails' : 'order.showDetails') | t }}</button>

        <div class="order-details" *ngIf="isExpanded(order)" [id]="'order-details-' + order.id">
          <dl>
            <div class="detail-row">
              <dt>{{ 'order.orderId' | t }}</dt>
              <dd class="mono">{{ order.id }}</dd>
            </div>
            <div class="detail-row">
              <dt>{{ 'order.createdAt' | t }}</dt>
              <dd>{{ order.created_at | dateTimeFormat }}</dd>
            </div>
            <!-- There is no per-status history on the backend, only the time
                 of the latest change; say exactly that rather than invent a
                 timeline. -->
            <div class="detail-row" *ngIf="order.updated_at">
              <dt>{{ 'order.updatedAt' | t }}</dt>
              <dd>{{ order.updated_at | dateTimeFormat }}</dd>
            </div>
            <!-- The admin console tells staff this reason is shown to both
                 sides, so show it. -->
            <div class="detail-row" *ngIf="platformCancelReason(order) as reason">
              <dt>{{ 'order.platformCancelReason' | t }}</dt>
              <dd>{{ reason }}</dd>
            </div>
            <div class="detail-row">
              <dt>{{ 'order.meetupTimeLabel' | t }}</dt>
              <dd>{{ order.meetup_time ? (order.meetup_time | dateTimeFormat) : ('order.notArrangedYet' | t) }}</dd>
            </div>
            <div class="detail-row">
              <dt>{{ 'order.meetupLocationLabel' | t }}</dt>
              <dd>{{ order.meetup_location || ('order.notArrangedYet' | t) }}</dd>
            </div>
          </dl>
          <div class="detail-links">
            <a *ngIf="!order.listing_deleted" [regionLink]="['/listing', order.listing]">{{ 'order.viewListing' | t }}</a>
            <span *ngIf="order.listing_deleted" class="text-muted">{{ 'common.listingDeleted' | t }}</span>
            <a *ngIf="order.conversation_id" [regionLink]="['/messages']" [queryParams]="{ chat: order.conversation_id }">{{ 'order.openConversation' | t }}</a>
          </div>
        </div>
      </ng-template>
    </ui-pull-to-refresh>

      <app-review-modal *ngIf="reviewingOrderId" [orderId]="reviewingOrderId" (onClosed)="onReviewModalClosed($event)"></app-review-modal>
  `,
  styles: [`
    .tabs {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--line);
    }
    .tab {
      background: none;
      border: none;
      padding: 8px 16px;
      font-size: var(--text-md);
      cursor: pointer;
      color: var(--muted);
      border-bottom: 2px solid transparent;
    }
    .tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 700;
    }
    .order-card {
      padding: 24px 0;
      border-bottom: 1px solid var(--line);
    }
    .order-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .order-summary {
      cursor: pointer;
    }
    .order-meta {
      color: var(--muted);
      font-size: var(--text-sm);
      font-variant-numeric: tabular-nums;
    }
    .order-ref {
      font-family: monospace;
    }
    .party {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .party-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }
    .party-initial {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--accent);
      color: var(--on-accent);
      font-size: var(--text-xs);
      font-weight: 700;
    }
    .details-toggle {
      margin-top: 8px;
      padding: 4px 0;
      background: none;
      border: none;
      color: var(--accent);
      font: inherit;
      font-size: var(--text-base);
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .order-details {
      margin-top: 8px;
      padding: 12px 16px;
      background: var(--paper-warm);
      border: 1px solid var(--line);
      border-radius: var(--radius-xs);
      font-size: var(--text-base);
    }
    .order-details dl {
      margin: 0;
    }
    .detail-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      padding: 4px 0;
    }
    .detail-row dt {
      color: var(--muted);
      min-width: 8em;
    }
    .detail-row dd {
      margin: 0;
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .mono {
      font-family: monospace;
    }
    .detail-links {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-top: 8px;
    }
    .detail-links a {
      color: var(--accent);
    }
    .badge {
      padding: 3px 7px;
      border-radius: 12px;
      font-size: var(--text-xs);
      font-weight: 700;
    }
    .deleted-tag {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--line-strong);
      color: var(--muted);
      font-family: inherit;
      font-size: var(--text-xs);
      font-weight: 500;
      vertical-align: middle;
    }
    .badge.pending { background: var(--paper-warm); color: var(--ink); border: 1px solid var(--line); }
    .badge.accepted { background: var(--warn-bg); color: var(--warn-ink); border: 1px solid color-mix(in srgb, var(--warn-ink) 40%, transparent); }
    .badge.handed_over { background: var(--accent-soft); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
    .badge.completed { background: var(--success-light); color: var(--success); border: 1px solid color-mix(in srgb, var(--success) 40%, transparent); }
    .badge.cancelled { background: var(--danger-light); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); }
    
    .exclusive-conflict {
      background: var(--warn-bg);
      color: var(--warn-ink);
      padding: 12px;
      border-radius: 4px;
      border: 1px solid color-mix(in srgb, var(--warn-ink) 40%, transparent);
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: var(--text-base);
    }
    .meetup-detail {
      font-size: var(--text-base);
      color: var(--accent) !important;
      font-weight: 500;
    }
    
    .order-body {
      display: flex;
      justify-content: space-between;
      gap: 16px;
    }
    .info {
      flex: 1;
      min-width: 0;
    }
    .info h3 {
      margin: 0 0 8px;
      font-size: var(--text-lg);
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .info p {
      margin: 4px 0;
      font-size: var(--text-base);
      color: var(--muted);
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .price {
      font-size: var(--text-xl);
      font-weight: 700;
      color: var(--accent);
      flex-shrink: 0;
    }
    .order-actions {
      display: flex;
      gap: 12px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px dashed var(--line);
      justify-content: flex-end;
    }
    /* The tint fading out is not decoration: arriving here from a
       notification, it is the only thing saying *which* of these rows is the
       order you were sent to look at. */
    .highlight-pulse {
      animation: highlight 2s;
    }
    @keyframes highlight {
      0% { background-color: var(--accent-soft); }
      100% { background-color: transparent; }
    }
    /* ...so under reduced motion it must not go through the global
       animation-duration: 0.01ms, which does not calm the effect down, it
       deletes it — the row would be pointed at for four thousandths of a
       second and the user would be left scanning the list by hand. The same
       information is carried statically instead: a flat tint that holds for
       the same two seconds the class is on the element (see checkHighlight),
       then disappears when the class is removed. Inside the media query so it
       cannot leak into the animated path. */
    @media (prefers-reduced-motion: reduce) {
      .highlight-pulse {
        animation: none;
        background-color: var(--accent-soft);
      }
    }
  `]
})
export class OrdersComponent implements OnInit {
  activeTab: 'buying' | 'selling' = 'buying';
  /** The first load is in flight: the placeholder shows. Later reloads
   *  (pull-to-refresh, a refused status change) keep the list on screen. */
  isLoading = true;
  /** The orders have loaded at least once. */
  private ordersLoaded = false;
  /** The first load failed: there is no list to fall back on. */
  loadFailed = false;
  refreshing = false;
  boughtOrders: Order[] = [];
  soldOrders: Order[] = [];
  reviewingOrderId: string | null = null;
  searchQuery = '';
  highlightOrderId: string | null = null;
  /** Orders whose details are open. */
  expandedOrderIds = new Set<string>();

  private orderService = inject(OrderService);
  private meetupDetails = inject(MeetupDetailsService);
  private authStore = inject(AuthStore);
  private accountService = inject(AccountService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private route = inject(ActivatedRoute);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private ga = inject(GoogleAnalyticsService);

  get filteredBoughtOrders() {
    return this.searchOrders(this.boughtOrders, o => o.seller_name);
  }

  get filteredSoldOrders() {
    return this.searchOrders(this.soldOrders, o => o.buyer_name);
  }

  /**
   * Orders matching the search box: by number, book title, authors, ISBN
   * (as printed, hyphens and all) or the other party's name.
   */
  private searchOrders(orders: Order[], otherParty: (o: Order) => string | undefined): Order[] {
    const q = this.searchQuery.toLowerCase().trim();
    if (!q) return orders;
    const ref = q.replace(/^#/, '').trim();
    const digits = q.replace(/[-\s]/g, '');
    const has = (text: string | null | undefined) => !!text && text.toLowerCase().includes(q);
    return orders.filter(o =>
      has(o.listing_title) || has(o.book_authors) || has(otherParty(o))
      || (!!ref && !!o.id && String(o.id).includes(ref))
      || (!!digits && !!o.book_isbn && o.book_isbn.includes(digits))
    );
  }

  shortRef(id: string | undefined): string {
    return (id || '').slice(0, 8);
  }

  isExpanded(order: Order): boolean {
    return !!order.id && this.expandedOrderIds.has(order.id);
  }

  toggleDetails(order: Order) {
    if (!order.id) return;
    if (this.expandedOrderIds.has(order.id)) this.expandedOrderIds.delete(order.id);
    else this.expandedOrderIds.add(order.id);
  }

  /** The other party, from the viewer's `role` on the order. */
  partyName(order: Order, role: 'buyer' | 'seller'): string {
    return (role === 'buyer' ? order.seller_name : order.buyer_name) || '';
  }

  partySchool(order: Order, role: 'buyer' | 'seller'): string {
    return (role === 'buyer' ? order.seller_school_name : order.buyer_school_name) || '';
  }

  partyAvatar(order: Order, role: 'buyer' | 'seller'): string {
    return (role === 'buyer' ? order.seller_avatar_url : order.buyer_avatar_url) || '';
  }

  hasActions(order: Order, role: 'buyer' | 'seller'): boolean {
    if (order.status === 'completed' && !order.has_reviewed) return true;
    if (role === 'buyer') {
      return order.status === 'pending' || order.status === 'accepted' || order.status === 'handed_over';
    } else {
      return order.status === 'pending' || order.status === 'accepted';
    }
  }

  onSearchQuery(query: string) {
    this.searchQuery = query;
  }

  ngOnInit() {
    // authGuard keeps signed-out visitors off this route. Signed out here
    // means the session ended while the page was opening (a refused token
    // refresh), and AuthStore.endSession() is already sending them to
    // /login with a returnUrl; a bare navigate from here raced it and won,
    // dropping the returnUrl.
    if (!this.authStore.isLoggedIn()) {
      return;
    }
    this.route.queryParams.subscribe(params => {
      if (params['orderId']) {
        this.highlightOrderId = params['orderId'];
      }
    });
    this.loadOrders();
  }

  currentUserId: string | null = null;
  lastSeenBought: string | null | undefined = null;
  lastSeenSold: string | null | undefined = null;

  /** The user picked a tab; no load overrides that choice. */
  private tabChosen = false;

  /** Which tab is current is known, so the tab bar may mark it. */
  get tabSettled(): boolean {
    return this.tabChosen || this.ordersLoaded;
  }

  setTab(tab: 'buying' | 'selling') {
    this.tabChosen = true;
    this.activeTab = tab;
    if (this.currentUserId) {
      this.markTabAsSeen(this.currentUserId);
    }
  }

  /** The side with the newest activity; buying when there is none. */
  private busiestTab(): 'buying' | 'selling' {
    if (this.soldOrders.length === 0) return 'buying';
    if (this.boughtOrders.length === 0) return 'selling';
    const newest = (orders: Order[]) => Math.max(...orders.map(o => new Date(o.updated_at || o.created_at || 0).getTime()));
    return newest(this.boughtOrders) >= newest(this.soldOrders) ? 'buying' : 'selling';
  }

  markTabAsSeen(userId: string) {
    let shouldUpdate = false;
    let payload: any = {};
    
    if (this.activeTab === 'buying') {
      const maxBought = this.boughtOrders.reduce((max, o) => Math.max(max, new Date(o.updated_at || o.created_at || 0).getTime()), 0);
      if (maxBought > 0) {
        this.lastSeenBought = new Date(maxBought).toISOString();
        payload.last_seen_bought_orders_at = this.lastSeenBought;
        shouldUpdate = true;
      }
    } else {
      const maxSold = this.soldOrders.reduce((max, o) => Math.max(max, new Date(o.updated_at || o.created_at || 0).getTime()), 0);
      if (maxSold > 0) {
        this.lastSeenSold = new Date(maxSold).toISOString();
        payload.last_seen_sold_orders_at = this.lastSeenSold;
        shouldUpdate = true;
      }
    }
    
    if (shouldUpdate) {
      this.accountService.updateProfile(payload).subscribe();
    }
    this.orderService.checkUnreadOrders(userId, this.lastSeenBought, this.lastSeenSold);
  }

  loadOrders() {
    this.isLoading = !this.ordersLoaded;
    this.loadFailed = false;
    this.accountService.getMyProfile().subscribe({
      next: (profile) => {
        const userId = profile.id;
        this.currentUserId = userId;
        this.lastSeenBought = profile.last_seen_bought_orders_at;
        this.lastSeenSold = profile.last_seen_sold_orders_at;
        
        this.orderService.getOrders().subscribe({
          next: (orders) => {
            this.boughtOrders = orders.filter(o => String(o.buyer) === String(userId));
            this.soldOrders = orders.filter(o => String(o.seller) === String(userId));
            
            // Only the first load picks the tab, and only if the user has not:
            // a refresh switching sides under the reader is the same jump.
            if (!this.ordersLoaded && !this.tabChosen) this.activeTab = this.busiestTab();

            this.markTabAsSeen(userId);
            this.ordersLoaded = true;
            this.isLoading = false;
            this.refreshing = false;
            this.cdr.markForCheck();
            this.checkHighlight();
          },
          error: (err) => {
            console.error('Failed to load orders', err);
            this.onLoadFailed();
          }
        });
      },
      error: (err) => {
        console.error('Failed to load profile', err);
        this.onLoadFailed();
      }
    });
  }

  private onLoadFailed() {
    this.isLoading = false;
    this.refreshing = false;
    // Over a list already showing, a toast; with nothing to show, the error
    // state with its retry, never the "no orders" empty state.
    if (this.ordersLoaded) this.toast.error(this.i18n.t('acct.ordersLoadFailed'));
    else this.loadFailed = true;
    this.cdr.markForCheck();
  }

  onRefresh() {
    this.refreshing = true;
    this.accountService.clearProfileCache();
    this.loadOrders();
  }

  checkHighlight() {
    if (!this.highlightOrderId) return;
    
    const isBought = this.boughtOrders.some(o => String(o.id) === this.highlightOrderId);
    const isSold = this.soldOrders.some(o => String(o.id) === this.highlightOrderId);
    
    if (isBought) this.activeTab = 'buying';
    else if (isSold) this.activeTab = 'selling';
    // Arriving from a notification or the chat's order link, the reader
    // wants this order's details, not just a tint saying which row it is.
    if (isBought || isSold) this.expandedOrderIds.add(this.highlightOrderId);
    this.cdr.markForCheck();
    
    setTimeout(() => {
      const el = document.getElementById('order-' + this.highlightOrderId);
      if (el) {
        el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
        el.classList.add('highlight-pulse');
        setTimeout(() => el.classList.remove('highlight-pulse'), 2000);
      }
    }, 100);
  }

  updateStatus(order: Order, status: string, cancelReason?: string, meetupTime?: string, meetupLocation?: string) {
    if (!order.id) return;
    this.orderService.updateOrderStatus(order.id, status, cancelReason, meetupTime, meetupLocation).subscribe({
      next: (updatedOrder) => {
        if (status === 'cancelled') {
          this.ga.trackCancelOrder(order.id, cancelReason);
        } else if (status === 'accepted' || status === 'handed_over') {
          this.ga.trackOrderStep(order.id, status);
        } else if (status === 'completed') {
          this.ga.trackPurchase({ ...order, ...updatedOrder });
        }
        // Find and replace - MERGE updated fields with existing order
        if (this.activeTab === 'buying') {
          const idx = this.boughtOrders.findIndex(o => o.id === order.id);
          if (idx !== -1) this.boughtOrders[idx] = { ...this.boughtOrders[idx], ...updatedOrder };
        } else {
          const idx = this.soldOrders.findIndex(o => o.id === order.id);
          if (idx !== -1) this.soldOrders[idx] = { ...this.soldOrders[idx], ...updatedOrder };
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        // This subscribe had no error branch at all, so a refused transition
        // was invisible: the seller pressed Accept and nothing whatsoever
        // happened. The backend now takes a row lock and refuses an accept
        // whose listing is no longer active — another buyer's order reserved
        // it first, or the seller has since marked it sold — and this list is
        // simply out of date about that.
        this.toast.error(parseApiError(err, this.i18n, 'acct.updateFailed'));
        // Only the codes that mean "your copy of this row is out of date".
        // A 401 is the interceptor's business and re-reading on it would just
        // fail again; a dropped connection says nothing about the row at all.
        if ([400, 403, 404, 409].includes(err?.status)) {
          this.loadOrders();
        }
        this.cdr.markForCheck();
      }
    });
  }

  async approveOrder(order: Order) {
    const details = await this.meetupDetails.ask(order.listing_title || '');
    if (!details) return;
    this.updateStatus(order, 'accepted', undefined, details.time || undefined, details.location || undefined);
  }

  /**
   * A platform cancel stores `admin_override: <the staff member's reason>`,
   * which is no i18n key — looked up as one, the raw key was shown. Collapse
   * it to its own label; the reason itself is for the audit trail.
   */
  cancelReasonKey(reason: string): string {
    return reason.startsWith('admin_override') ? 'order.cancel_reason.admin_override' : `order.cancel_reason.${reason}`;
  }

  platformCancelReason(order: Order): string {
    const reason = order.status === 'cancelled' ? order.cancel_reason || '' : '';
    return reason.startsWith('admin_override:') ? reason.slice('admin_override:'.length).trim() : '';
  }

  hasExclusiveConflict(order: Order): boolean {
    if (order.status !== 'accepted' && order.status !== 'handed_over') return false;
    return this.boughtOrders.some(o => 
      o.listing_title === order.listing_title && o.status === 'pending'
    );
  }

  cancelOtherPending(acceptedOrder: Order) {
    const toCancel = this.boughtOrders.filter(o => 
      o.listing_title === acceptedOrder.listing_title && o.status === 'pending'
    );
    toCancel.forEach(o => {
      this.updateStatus(o, 'cancelled', 'buyer_cancelled');
    });
  }

  onReviewModalClosed(success: boolean) {
    this.reviewingOrderId = null;
    if (success) {
      if (this.currentReviewOrderRef) {
        this.currentReviewOrderRef.has_reviewed = true;
      }
      this.ga.trackSubmitReview(this.currentReviewOrderRef?.id);
      this.toast.success(this.i18n.t('order.reviewSubmitted'));
      this.cdr.markForCheck();
    }
  }

  private currentReviewOrderRef: Order | null = null;

  openReviewModal(order: Order) {
    this.currentReviewOrderRef = order;
    this.reviewingOrderId = order.id || null;
  }
}
