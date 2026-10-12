import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { OrderService } from './order.service';

// The account shell's unread dot fetched the whole order list on every
// profile load, on top of the orders page fetching it too.
describe('OrderService.checkUnreadOrders', () => {
  let service: OrderService;
  let http: HttpTestingController;
  const orders = () => http.match(req => req.url === '/orders/');

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(OrderService);
    http = TestBed.inject(HttpTestingController);
  });

  it('joins a list request already in flight instead of sending another', () => {
    let pageOrders: unknown[] | null = null;
    service.getOrders().subscribe(o => (pageOrders = o));
    service.checkUnreadOrders('1', null, null);

    const pending = orders();
    expect(pending).toHaveLength(1);
    pending[0].flush([{ id: 'a', buyer: '1', seller: '2', updated_at: '2026-09-19T00:00:00Z' }]);
    expect(pageOrders).toHaveLength(1);
    expect(service.unreadOrders$.value).toBe(true);
  });

  it('reuses a list fetched moments ago, but not after an order changed', () => {
    service.checkUnreadOrders('1', null, null);
    orders()[0].flush([]);

    service.checkUnreadOrders('1', null, null);
    expect(orders()).toHaveLength(0);

    service.updateOrderStatus('a', 'accepted').subscribe();
    http.expectOne(req => req.method === 'PATCH').flush({});
    service.checkUnreadOrders('1', null, null);
    expect(orders()).toHaveLength(1);
  });

  it('lets the orders page join the unread check\'s request instead of sending its own', () => {
    service.checkUnreadOrders('1', null, null);
    let pageOrders: unknown[] | null = null;
    service.getOrders().subscribe(o => (pageOrders = o));
    const pending = orders();
    expect(pending).toHaveLength(1);
    pending[0].flush([{ id: 'a', buyer: '1', seller: '2' }]);
    expect(pageOrders).toHaveLength(1);
  });

  it('reuses a list fetched seconds ago for the orders page, but fetches again after that', () => {
    vi.useFakeTimers();
    service.checkUnreadOrders('1', null, null);
    orders()[0].flush([]);
    service.getOrders().subscribe();
    expect(orders()).toHaveLength(0);

    vi.advanceTimersByTime(6000);
    service.getOrders().subscribe();
    expect(orders()).toHaveLength(1);
    vi.useRealTimers();
  });
});
