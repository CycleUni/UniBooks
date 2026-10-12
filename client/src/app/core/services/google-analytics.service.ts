import { ApplicationRef, Injectable, Injector, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { RegionService } from '../region.service';
import { whenPageSettled } from '../page-settled';
import { redactSensitiveUrl } from '../sensitive-url';

@Injectable({
  providedIn: 'root'
})
export class GoogleAnalyticsService {
  private platformId = inject(PLATFORM_ID);
  private router = inject(Router);
  // Looked up on use, not injected: RegionService's own dependencies lead back
  // to AuthStore, which injects this service.
  private injector = inject(Injector);
  private appRef = inject(ApplicationRef);
  private initialized = false;
  private gaId: string | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    const gaId = environment.gaMeasurementId;
    if (!gaId || !isPlatformBrowser(this.platformId) || this.initialized) {
      return;
    }

    this.gaId = gaId;

    // Load Google Analytics script once the first page is up (see
    // whenPageSettled). Until then gtag() only queues onto dataLayer, which
    // the script replays when it arrives, so nothing tracked is lost.
    whenPageSettled(this.appRef).then(() => {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
      document.head.appendChild(script);
    });

    // Initialize dataLayer and gtag function
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).gtag = function() {
      // eslint-disable-next-line prefer-rest-params
      (window as any).dataLayer.push(arguments);
    };
    
    const gtag = (window as any).gtag;
    gtag('js', new Date());
    // Disable automatic page view so we can track SPA route changes manually
    gtag('config', gaId, { send_page_view: false });

    this.initialized = true;

    // Track route changes via Angular Router
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe((event: any) => {
      // Both redacted: gtag reports page_location (the full address) with
      // every page view, so the reset and email-change links' tokens reached
      // GA even though page_path was the only thing set here.
      gtag('config', gaId, {
        page_path: redactSensitiveUrl(event.urlAfterRedirects),
        page_location: redactSensitiveUrl(window.location.href),
      });
    });
  }

  /**
   * Generic GA4 event tracking. Every event carries the site `region` (TW /
   * HK) so reports can be split the way the admin statistics are; register
   * it as an event-scoped custom dimension in GA to use it.
   */
  public trackEvent(eventName: string, params: Record<string, any> = {}): void {
    if (isPlatformBrowser(this.platformId) && (window as any).gtag) {
      (window as any).gtag('event', eventName, { region: this.region() || undefined, ...params });
    }
  }

  private region(): string {
    try {
      return this.injector.get(RegionService).region().toUpperCase();
    } catch {
      return '';
    }
  }

  /**
   * GA wants money in major units with its currency; the API sends minor
   * units (TWD has none, HKD has cents). Without a currency, the current
   * region's is assumed.
   */
  private money(minor: number | null | undefined, currencyCode?: string | null): { value: number; currency: string } {
    let code = currencyCode || 'TWD';
    let places = 0;
    try {
      const regions = this.injector.get(RegionService);
      const current = regions.currency();
      code = currencyCode || current.code;
      const match = regions.regions().find(r => r.currency.code === code)?.currency ?? (current.code === code ? current : null);
      places = match ? match.decimal_places : 0;
    } catch {
      // No region data (tests, early boot): fall through with TWD / 0.
    }
    return { value: (minor ?? 0) / Math.pow(10, places), currency: code };
  }

  private orderItem(order: { listing?: string | number | null; listing_title?: string; total_amount?: number | null; currency?: string | null }) {
    return {
      item_id: order.listing != null ? String(order.listing) : '',
      item_name: order.listing_title || '',
      price: this.money(order.total_amount, order.currency).value,
    };
  }

  /**
   * Track user registration
   */
  public trackSignUp(method: 'Email' | 'Google' = 'Email'): void {
    this.trackEvent('sign_up', { method });
  }

  /**
   * Track user login
   */
  public trackLogin(method: 'Password' | 'Google' = 'Password'): void {
    this.trackEvent('login', { method });
  }

  /**
   * Track search action
   */
  public trackSearch(searchTerm: string, totalResults?: number, school?: string): void {
    this.trackEvent('search', {
      search_term: searchTerm,
      total_results: totalResults,
      school: school || undefined
    });
  }

  /**
   * Track item detail view (GA4 standard view_item)
   * item_id uses book-level identifier (isbn or bookId) so GA4 product reports
   * can aggregate across multiple listings of the same book.
   * listing_id is passed as a custom parameter for traceability.
   */
  public trackViewItem(item: {
    bookId?: string | number | null;
    isbn?: string | null;
    listingId?: string | number | null;
    name?: string;
    category?: string;
    price?: number;
    currency?: string | null;
  }): void {
    const itemId = item.isbn || (item.bookId != null ? String(item.bookId) : '');
    const { value, currency } = this.money(item.price, item.currency);
    this.trackEvent('view_item', {
      currency,
      value,
      items: [
        {
          item_id: itemId,
          item_name: item.name || '',
          item_category: item.category || '',
          price: value,
          ...(item.listingId != null ? { listing_id: String(item.listingId) } : {})
        }
      ]
    });
  }

  /**
   * Track seller item publication
   */
  public trackPublishListing(category?: string, condition?: string, price?: number | null): void {
    const { value, currency } = this.money(price);
    this.trackEvent('publish_listing', {
      item_category: category || '',
      item_condition: condition || '',
      price: value,
      currency
    });
  }

  /**
   * Track initiate checkout (GA4 standard begin_checkout)
   * item_id uses book-level identifier (isbn or bookId) for meaningful product aggregation.
   */
  public trackBeginCheckout(opts: {
    listingId?: string | number | null;
    bookId?: string | number | null;
    isbn?: string | null;
    itemName?: string;
    price?: number | null;
    currency?: string | null;
  }): void {
    const itemId = opts.isbn || (opts.bookId != null ? String(opts.bookId) : '');
    const { value, currency } = this.money(opts.price, opts.currency);
    this.trackEvent('begin_checkout', {
      currency,
      value,
      items: [{
        item_id: itemId,
        item_name: opts.itemName || '',
        price: value,
        ...(opts.listingId != null ? { listing_id: String(opts.listingId) } : {})
      }]
    });
  }

  /**
   * An order request sent to the seller. Not GA's `purchase`: most requests
   * are still to be accepted and met, and some never are.
   */
  public trackPlaceOrder(order: { id?: string | null; listing?: string | number | null; listing_title?: string; total_amount?: number | null; currency?: string | null }): void {
    const { value, currency } = this.money(order.total_amount, order.currency);
    this.trackEvent('place_order', {
      order_id: order.id || '',
      currency,
      value,
      items: [this.orderItem(order)]
    });
  }

  /**
   * GA4 standard `purchase`, sent when the buyer confirms receipt — the point
   * the admin statistics count a transaction — so GA revenue and the admin's
   * sales total describe the same thing.
   */
  public trackPurchase(order: { id?: string | null; listing?: string | number | null; listing_title?: string; total_amount?: number | null; currency?: string | null }): void {
    const { value, currency } = this.money(order.total_amount, order.currency);
    this.trackEvent('purchase', {
      transaction_id: order.id || '',
      currency,
      value,
      items: [this.orderItem(order)]
    });
  }

  /** Seller accepted, or handed the book over: the steps between request and purchase. */
  public trackOrderStep(orderId: string | null | undefined, status: 'accepted' | 'handed_over'): void {
    this.trackEvent(status === 'accepted' ? 'order_accepted' : 'order_handed_over', {
      order_id: orderId || ''
    });
  }

  /**
   * A book page opened. Book-level demand, including books nobody is
   * selling — `listing_count` 0 marks interest the platform cannot meet yet.
   */
  public trackViewBook(book: { id?: string | number | null; isbn?: string | null; title?: string; listingCount?: number }): void {
    this.trackEvent('view_book', {
      item_id: book.isbn || (book.id != null ? String(book.id) : ''),
      item_name: book.title || '',
      listing_count: book.listingCount ?? 0
    });
  }

  /** A book request (求書) registered. */
  public trackRequestBook(bookId: string | number | null | undefined, source: 'book' | 'search'): void {
    this.trackEvent('request_book', {
      item_id: bookId != null ? String(bookId) : '',
      source
    });
  }

  /**
   * Track buyer contacting seller
   */
  public trackContactSeller(listingId?: string | number | null): void {
    this.trackEvent('contact_seller', {
      item_id: listingId != null ? String(listingId) : ''
    });
  }

  /**
   * Track chat message sent
   */
  public trackSendMessage(conversationId?: string | number | null): void {
    this.trackEvent('send_message', {
      conversation_id: conversationId != null ? String(conversationId) : undefined
    });
  }

  /**
   * Track order cancellation
   */
  public trackCancelOrder(orderId?: string | number | null, reason?: string): void {
    this.trackEvent('cancel_order', {
      order_id: orderId != null ? String(orderId) : '',
      cancel_reason: reason || ''
    });
  }

  /**
   * Track review submission
   */
  public trackSubmitReview(orderId?: string | number, rating?: number): void {
    this.trackEvent('submit_review', {
      order_id: orderId ? String(orderId) : undefined,
      rating: rating ?? 0
    });
  }

  /**
   * Track .edu verification request
   */
  public trackEduVerificationRequest(): void {
    this.trackEvent('verify_edu_request');
  }

  // ─── User Identity & Properties ────────────────────────────────────────────

  /**
   * Set GA4 user_id for cross-device tracking and User Explorer reports.
   * Call after login/profile load; pass null to clear on logout.
   */
  public setUserId(userId: string | number | null): void {
    if (!isPlatformBrowser(this.platformId) || !this.gaId || !(window as any).gtag) return;
    if (userId != null) {
      (window as any).gtag('config', this.gaId, { user_id: String(userId) });
    } else {
      // Clear user_id on logout
      (window as any).gtag('config', this.gaId, { user_id: null });
    }
  }

  /**
   * Set GA4 user properties for audience segmentation.
   * These enhance all built-in reports (Retention, Acquisition, etc.).
   */
  public setUserProperties(props: {
    school?: string | null;
    verified_region_count?: number;
    role?: 'buyer' | 'seller' | 'both' | null;
  }): void {
    if (!isPlatformBrowser(this.platformId) || !(window as any).gtag) return;
    (window as any).gtag('set', 'user_properties', {
      school:      props.school      ?? undefined,
      verified_region_count: props.verified_region_count ?? undefined,
      role:        props.role        ?? undefined
    });
  }

  /**
   * Clear GA4 user properties on logout so anonymous browsing is not
   * still attributed to the previous user's segment.
   */
  public clearUserProperties(): void {
    if (!isPlatformBrowser(this.platformId) || !(window as any).gtag) return;
    (window as any).gtag('set', 'user_properties', {
      school: null,
      verified_region_count: null,
      role: null
    });
  }

  // ─── Scroll Depth ───────────────────────────────────────────────────────────

  /**
   * Track page scroll depth milestones (25 / 50 / 75 / 90 %).
   * GA4 Enhanced Measurement only fires at 90%; this gives finer granularity.
   */
  public trackScrollDepth(percent: 25 | 50 | 75 | 90): void {
    this.trackEvent('scroll', { percent_scrolled: percent });
  }
}
