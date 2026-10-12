import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { OrdersComponent } from './orders';
import { en } from '../../core/i18n/en';

describe('OrdersComponent.updateStatus', () => {
  let component: OrdersComponent;
  let updateOrderStatus: ReturnType<typeof vi.fn>;
  let toastError: ReturnType<typeof vi.fn>;

  const pendingOrder = { id: 'o1', listing: 'l1', status: 'pending', buyer: 'u2', seller: 'u1' };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OrdersComponent, HttpClientTestingModule, RouterTestingModule],
    });
    component = TestBed.createComponent(OrdersComponent).componentInstance;

    updateOrderStatus = vi.fn().mockReturnValue(of({ ...pendingOrder, status: 'accepted' }));
    toastError = vi.fn();
    (component as any).orderService = { updateOrderStatus };
    (component as any).toast = { error: toastError, success: vi.fn() };
    component.loadOrders = vi.fn();
    component.soldOrders = [{ ...pendingOrder }];
    component.activeTab = 'selling';
  });

  it('merges the updated order in on success', () => {
    component.updateStatus(component.soldOrders[0], 'accepted');

    expect(component.soldOrders[0].status).toBe('accepted');
    expect(toastError).not.toHaveBeenCalled();
    expect(component.loadOrders).not.toHaveBeenCalled();
  });

  it('explains a refused accept and re-reads the stale list', () => {
    // The backend takes a row lock and refuses an accept whose listing is no
    // longer active — another buyer got there first, or the seller has since
    // marked it sold. There was no error branch here at all, so the seller
    // pressed Accept and nothing whatsoever happened.
    updateOrderStatus.mockReturnValue(throwError(() => ({
      status: 400,
      error: { status: ['checkout.errListingUnavailable'] },
    })));

    component.updateStatus(component.soldOrders[0], 'accepted');

    expect(toastError).toHaveBeenCalledWith(en['checkout.errListingUnavailable']);
    expect(component.loadOrders).toHaveBeenCalled();
    expect(component.soldOrders[0].status).toBe('pending');
  });

  it('leaves an expired session to the interceptor', () => {
    updateOrderStatus.mockReturnValue(throwError(() => ({ status: 401, error: null })));

    component.updateStatus(component.soldOrders[0], 'accepted');

    expect(component.loadOrders).not.toHaveBeenCalled();
  });

  it('does not re-read the list when the request never reached the server', () => {
    // A dropped connection says nothing about whether this row is stale, and
    // reloading on it would just fail again.
    updateOrderStatus.mockReturnValue(throwError(() => ({ status: 0, error: null })));

    component.updateStatus(component.soldOrders[0], 'accepted');

    expect(toastError).toHaveBeenCalledWith(en['acct.updateFailed']);
    expect(component.loadOrders).not.toHaveBeenCalled();
  });
});

describe('OrdersComponent order rows', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<OrdersComponent>>;
  let component: OrdersComponent;

  const order = {
    id: '5f1a63f6-bfb9-421a-a0d4-ad970dd2c5b9',
    listing: 'l1',
    listing_title: 'Calculus',
    status: 'accepted',
    buyer: 'u1',
    seller: 'u2',
    seller_name: '周恭煥',
    seller_school_name: 'National Taiwan University',
    seller_avatar_url: '',
    total_amount: 100,
    currency: 'TWD',
    created_at: '2026-09-01T10:00:00+08:00',
    updated_at: '2026-09-02T12:30:00+08:00',
    meetup_time: '2026-09-05T15:00:00+08:00',
    meetup_location: 'Library entrance',
    conversation_id: 'c1',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OrdersComponent, HttpClientTestingModule, RouterTestingModule],
    });
    fixture = TestBed.createComponent(OrdersComponent);
    component = fixture.componentInstance;
    // Rendering only: skip the login redirect and the profile/orders fetch.
    component.ngOnInit = () => {};
    component.isLoading = false;
    component.activeTab = 'buying';
    component.boughtOrders = [{ ...order }];
  });

  const text = () => fixture.nativeElement.textContent as string;

  it('heads the row with a short reference and date instead of the full id', () => {
    fixture.detectChanges();
    const ref = fixture.nativeElement.querySelector('.order-ref');
    expect(ref.textContent.trim()).toBe('#5f1a63f6');
    expect(text()).not.toContain(order.id);
    expect(fixture.nativeElement.querySelector('.order-date time').getAttribute('datetime')).toBe(order.created_at);
  });

  it("names the other party with their school, so same-named users can be told apart", () => {
    fixture.detectChanges();
    const party = fixture.nativeElement.querySelector('.party').textContent;
    expect(party).toContain('周恭煥');
    expect(party).toContain('National Taiwan University');
  });

  it('expands to the full id, meetup, listing and conversation links', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.order-details')).toBeNull();

    const toggle: HTMLButtonElement = fixture.nativeElement.querySelector('.details-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    fixture.detectChanges();

    const details: HTMLElement = fixture.nativeElement.querySelector('.order-details');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.textContent).toContain(order.id);
    expect(details.textContent).toContain('Library entrance');
    const hrefs = Array.from(details.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(hrefs.some(h => h?.includes('/listing/l1'))).toBe(true);
    expect(hrefs.some(h => h?.includes('/messages') && h.includes('chat=c1'))).toBe(true);
  });

  it('offers no conversation link when there is no chat to open', () => {
    component.boughtOrders = [{ ...order, conversation_id: null, meetup_time: undefined, meetup_location: '' }];
    component.expandedOrderIds.add(order.id);
    fixture.detectChanges();
    const details: HTMLElement = fixture.nativeElement.querySelector('.order-details');
    expect(details.querySelectorAll('a').length).toBe(1);
    expect(details.textContent).toContain(en['order.notArrangedYet']);
  });

  it('opens the details of the order named in ?orderId=', () => {
    vi.useFakeTimers();
    component.highlightOrderId = order.id;
    component.checkHighlight();
    vi.runAllTimers();
    vi.useRealTimers();
    expect(component.isExpanded(component.boughtOrders[0])).toBe(true);
  });
});

describe('OrdersComponent.approveOrder', () => {
  let component: OrdersComponent;
  let ask: ReturnType<typeof vi.fn>;
  const order = { id: 'o1', listing: 'l1', listing_title: 'Calculus', status: 'pending', buyer: 'u2', seller: 'u1' } as any;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OrdersComponent, HttpClientTestingModule, RouterTestingModule],
    });
    component = TestBed.createComponent(OrdersComponent).componentInstance;
    ask = vi.fn();
    (component as any).meetupDetails = { ask };
    component.updateStatus = vi.fn();
  });

  it('asks for the meetup time and place, then accepts with them', async () => {
    ask.mockResolvedValue({ time: '2026-10-01 15:00', location: 'Library' });
    await component.approveOrder(order);
    expect(ask).toHaveBeenCalledWith('Calculus');
    expect(component.updateStatus).toHaveBeenCalledWith(order, 'accepted', undefined, '2026-10-01 15:00', 'Library');
  });

  it('does not accept when the form is closed', async () => {
    ask.mockResolvedValue(null);
    await component.approveOrder(order);
    expect(component.updateStatus).not.toHaveBeenCalled();
  });

  it('re-fetches orders on onRefresh', () => {
    const clearProfileCache = vi.fn();
    (component as any).accountService = { clearProfileCache, getMyProfile: vi.fn().mockReturnValue(of({ id: 'u1' })) };
    (component as any).orderService = { getOrders: vi.fn().mockReturnValue(of([])), checkUnreadOrders: vi.fn() };

    component.onRefresh();

    expect(clearProfileCache).toHaveBeenCalled();
    expect(component.refreshing).toBe(false);
  });

  // A failed load is not "no orders yet", and a reload must not blank a list
  // that is already on screen.
  describe('loading states', () => {
    let getOrders: ReturnType<typeof vi.fn>;
    let toastError: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      getOrders = vi.fn();
      toastError = vi.fn();
      (component as any).accountService = { clearProfileCache: vi.fn(), getMyProfile: vi.fn().mockReturnValue(of({ id: 'u1' })), updateProfile: vi.fn().mockReturnValue(of({})) };
      (component as any).orderService = { getOrders, checkUnreadOrders: vi.fn(), markOrdersAsSeen: vi.fn().mockReturnValue(of({})) };
      (component as any).toast = { error: toastError, success: vi.fn() };
      (component as any).i18n = { t: (k: string) => k };
    });

    it('shows the error state, not the empty one, when the first load fails, and retries', () => {
      getOrders.mockReturnValueOnce(throwError(() => ({ status: 500 })));
      component.loadOrders();
      expect(component.isLoading).toBe(false);
      expect(component.loadFailed).toBe(true);
      expect(toastError).not.toHaveBeenCalled();

      getOrders.mockReturnValueOnce(of([]));
      component.loadOrders();
      expect(component.loadFailed).toBe(false);
    });

    const sold = { id: 's1', buyer: 'u2', seller: 'u1', created_at: '2026-10-02T00:00:00Z' };
    const bought = { id: 'b1', buyer: 'u1', seller: 'u2', created_at: '2026-10-01T00:00:00Z' };

    // Marking "Purchases" by default and moving the mark to "Sales" once the
    // orders said that side was busier was a visible jump.
    it('marks no tab until the first load picks one', () => {
      getOrders.mockReturnValueOnce(new Observable(() => {}));
      component.loadOrders();
      expect(component.tabSettled).toBe(false);

      getOrders.mockReturnValueOnce(of([sold, bought]));
      component.loadOrders();
      expect(component.tabSettled).toBe(true);
      expect(component.activeTab).toBe('selling');
    });

    it('keeps a tab the user picked while loading', () => {
      getOrders.mockReturnValueOnce(new Observable(() => {}));
      component.loadOrders();
      component.setTab('buying');
      expect(component.tabSettled).toBe(true);

      getOrders.mockReturnValueOnce(of([sold, bought]));
      component.loadOrders();
      expect(component.activeTab).toBe('buying');
    });

    it('does not switch sides on a refresh', () => {
      getOrders.mockReturnValueOnce(of([bought]));
      component.loadOrders();
      expect(component.activeTab).toBe('buying');

      getOrders.mockReturnValueOnce(of([sold, bought]));
      component.onRefresh();
      expect(component.activeTab).toBe('buying');
    });

    it('keeps the list up through a reload, and toasts when that reload fails', () => {
      getOrders.mockReturnValueOnce(of([]));
      component.loadOrders();

      getOrders.mockReturnValueOnce(new Observable(() => {}));
      component.loadOrders();
      expect(component.isLoading).toBe(false);

      getOrders.mockReturnValueOnce(throwError(() => ({ status: 500 })));
      component.onRefresh();
      expect(component.loadFailed).toBe(false);
      expect(component.refreshing).toBe(false);
      expect(toastError).toHaveBeenCalledWith('acct.ordersLoadFailed');
    });
  });
});

describe('OrdersComponent when the session ended while opening', () => {
  it('leaves the redirect to AuthStore, which keeps the returnUrl', () => {
    TestBed.configureTestingModule({ imports: [OrdersComponent, HttpClientTestingModule, RouterTestingModule] });
    const component = TestBed.createComponent(OrdersComponent).componentInstance;
    const navigate = vi.fn();
    (component as any).router = { navigate };
    (component as any).authStore = { isLoggedIn: () => false };
    component.loadOrders = vi.fn();

    component.ngOnInit();

    expect(navigate).not.toHaveBeenCalled();
    expect(component.loadOrders).not.toHaveBeenCalled();
  });
});

describe('OrdersComponent platform cancels', () => {
  let component: OrdersComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OrdersComponent, HttpClientTestingModule, RouterTestingModule] });
    component = TestBed.createComponent(OrdersComponent).componentInstance;
  });

  it('labels a platform cancel instead of looking its reason up as a key', () => {
    expect(component.cancelReasonKey('admin_override: counterfeit')).toBe('order.cancel_reason.admin_override');
    expect(component.cancelReasonKey('buyer_cancelled')).toBe('order.cancel_reason.buyer_cancelled');
    expect(en['order.cancel_reason.admin_override']).toBeTruthy();
  });

  it('shows the reason staff gave, only on a platform cancel', () => {
    const order = (o: any) => ({ listing: 'l1', ...o });
    expect(component.platformCancelReason(order({ status: 'cancelled', cancel_reason: 'admin_override: counterfeit' }))).toBe('counterfeit');
    expect(component.platformCancelReason(order({ status: 'cancelled', cancel_reason: 'buyer_cancelled' }))).toBe('');
    expect(component.platformCancelReason(order({ status: 'completed', cancel_reason: 'admin_override: x' }))).toBe('');
  });
});

describe('OrdersComponent search', () => {
  let component: OrdersComponent;
  const order = {
    id: 'a1b2c3d4-0000', listing: 'l1', status: 'completed', buyer: 'u2', seller: 'u1',
    listing_title: 'Principles of Economics', book_authors: 'N. Gregory Mankiw',
    book_isbn: '9781305585126', seller_name: 'Alice Chen', buyer_name: 'Bob Lin',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OrdersComponent, HttpClientTestingModule, RouterTestingModule],
    });
    component = TestBed.createComponent(OrdersComponent).componentInstance;
    component.boughtOrders = [{ ...order }];
    component.soldOrders = [{ ...order }];
  });

  const found = (q: string) => {
    component.searchQuery = q;
    return component.filteredBoughtOrders.length;
  };

  it('matches number, title, author and ISBN as printed', () => {
    expect(found('#a1b2')).toBe(1);
    expect(found('economics')).toBe(1);
    expect(found('mankiw')).toBe(1);
    expect(found('978-1-305-58512-6')).toBe(1);
    expect(found('calculus')).toBe(0);
  });

  it('matches the other party: the seller when buying, the buyer when selling', () => {
    expect(found('alice')).toBe(1);
    expect(found('bob')).toBe(0);
    component.searchQuery = 'bob';
    expect(component.filteredSoldOrders.length).toBe(1);
  });
});
