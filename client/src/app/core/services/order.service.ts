import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { finalize, map, shareReplay, tap } from 'rxjs/operators';
import { Observable, BehaviorSubject, of } from 'rxjs';

export interface Order {
  id?: string;
  buyer?: string;
  seller?: string;
  buyer_name?: string;
  seller_name?: string;
  /** Display names are not unique; these tell two same-named users apart. */
  buyer_school_name?: string;
  seller_school_name?: string;
  buyer_avatar_url?: string | null;
  seller_avatar_url?: string | null;
  /** The chat this order was arranged in; null if the viewer deleted it. */
  conversation_id?: string | null;
  listing_title?: string;
  /** The book's authors, for searching; null once the listing is deleted. */
  book_authors?: string | null;
  /** Null once the seller deletes the listing; the order keeps its snapshot. */
  listing: string | null;
  listing_ref?: string;
  book_isbn?: string;
  listing_deleted?: boolean;
  status?: string;
  cancel_reason?: string;
  total_amount?: number;
  /** ISO 4217 code; total_amount is in this currency's minor units. */
  currency?: string;
  meetup_time?: string;
  meetup_location?: string;
  created_at?: string;
  updated_at?: string;
  has_reviewed?: boolean;
}

@Injectable({ providedIn: 'root' })
export class OrderService {
  private http = inject(HttpClient);
  private url = '/orders/';

  public unreadOrders$ = new BehaviorSubject<boolean>(false);

  /**
   * The unread dot needs the whole order list, which the orders page is often
   * fetching at the same moment. Shared with getOrders(): a request already
   * out is joined, and a list fetched in the last 30 seconds is reused, so
   * the account shell and the orders page do not each download it.
   */
  private static readonly RECENT_ORDERS_MS = 30_000;
  /** How fresh a list must be for the orders page itself to reuse it. */
  private static readonly JUST_FETCHED_MS = 5_000;
  private ordersInFlight: Observable<Order[]> | null = null;
  private recentOrders: { at: number; orders: Order[] } | null = null;

  private ordersForUnreadCheck(): Observable<Order[]> {
    if (this.ordersInFlight) return this.ordersInFlight;
    if (this.recentOrders && Date.now() - this.recentOrders.at < OrderService.RECENT_ORDERS_MS) {
      return of(this.recentOrders.orders);
    }
    return this.getOrders();
  }

  checkUnreadOrders(userId: string, lastSeenBoughtAt: string | null | undefined, lastSeenSoldAt: string | null | undefined) {
    this.ordersForUnreadCheck().subscribe(orders => {
      const boughtOrders = orders.filter(o => String(o.buyer) === String(userId));
      const soldOrders = orders.filter(o => String(o.seller) === String(userId));
      
      const lastSeenBought = lastSeenBoughtAt ? new Date(lastSeenBoughtAt).getTime() : 0;
      const lastSeenSold = lastSeenSoldAt ? new Date(lastSeenSoldAt).getTime() : 0;
      
      const maxBought = boughtOrders.reduce((max, o) => Math.max(max, new Date(o.updated_at || o.created_at || 0).getTime()), 0);
      const maxSold = soldOrders.reduce((max, o) => Math.max(max, new Date(o.updated_at || o.created_at || 0).getTime()), 0);
      
      this.unreadOrders$.next(maxBought > lastSeenBought || maxSold > lastSeenSold);
    });
  }

  /**
   * A fresh list: a request already out is joined, and one completed in the
   * last few seconds is reused — the account shell's unread check and the
   * orders page ask at nearly the same moment when the orders page opens.
   */
  getOrders(): Observable<Order[]> {
    if (this.ordersInFlight) return this.ordersInFlight;
    // Opening the orders page from the account shell: the shell's unread
    // check fetched this list a moment ago. Anything an order change could
    // have made stale is dropped by createOrder/updateOrderStatus.
    if (this.recentOrders && Date.now() - this.recentOrders.at < OrderService.JUST_FETCHED_MS) {
      return of(this.recentOrders.orders);
    }
    const request = this.http.get<any>(this.url).pipe(
      map(res => (res.results ? res.results : res) as Order[]),
      tap(orders => { this.recentOrders = { at: Date.now(), orders }; }),
      finalize(() => { if (this.ordersInFlight === request) this.ordersInFlight = null; }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.ordersInFlight = request;
    return request;
  }

  getOrder(id: string) {
    return this.http.get<Order>(this.url + id + '/');
  }

  createOrder(order: Order) {
    return this.http.post<Order>(this.url, order).pipe(tap(() => { this.recentOrders = null; }));
  }

  updateOrderStatus(id: string, status: string, cancelReason?: string, meetupTime?: string, meetupLocation?: string) {
    const body: any = { status };
    if (cancelReason) body.cancel_reason = cancelReason;
    if (meetupTime) body.meetup_time = meetupTime;
    if (meetupLocation) body.meetup_location = meetupLocation;
    return this.http.patch<Order>(this.url + id + '/', body).pipe(tap(() => { this.recentOrders = null; }));
  }

  /** The seller changes the agreed meetup; an empty time clears it. */
  updateMeetupDetails(id: string, meetupTime: string, meetupLocation: string) {
    const body = { meetup_time: meetupTime || null, meetup_location: meetupLocation };
    return this.http.patch<Order>(this.url + id + '/', body).pipe(tap(() => { this.recentOrders = null; }));
  }

  submitReview(orderId: string, rating: number | null, comment: string, isNoShow: boolean = false) {
    const body = {
      order: orderId,
      rating: rating,
      comment: comment,
      is_no_show: isNoShow
    };
    return this.http.post<any>(this.url + 'reviews/', body);
  }
}
