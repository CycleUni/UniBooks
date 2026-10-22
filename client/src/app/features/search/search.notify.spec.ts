import { Subject, throwError } from 'rxjs';
import { Search } from './search';

describe('Search notify-me buttons', () => {
  const host = (subscribe: () => any) =>
    Object.assign(Object.create(Search.prototype), {
      notifyBusy: new Set<any>(),
      auth: { isLoggedIn: () => true },
      bookService: { subscribe: vi.fn(subscribe) },
      toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
      i18n: { t: (k: string) => k, tOrNull: () => null },
      ga: { trackRequestBook: vi.fn() },
      cdr: { markForCheck: vi.fn() },
    }) as any;

  it('sends one request however often it is tapped while one is in flight', () => {
    const pending = new Subject<any>();
    const search = host(() => pending);
    const item = { id: 'b1', waitlistCount: 0 };
    search.subscribeBook(item);
    search.subscribeBook(item);
    expect(search.bookService.subscribe).toHaveBeenCalledTimes(1);
    pending.next({ id: 's1' });
    pending.complete();
    expect(item).toMatchObject({ is_subscribed: true, waitlistCount: 1 });
    expect(search.notifyBusy.has(item)).toBe(false);
  });

  it('says the subscribe failed, not the unsubscribe', () => {
    const search = host(() => throwError(() => ({ status: 500 })));
    search.subscribeBook({ id: 'b1', waitlistCount: 0 });
    expect(search.toast.error).toHaveBeenCalledWith('alert.subscribeFailed');
  });
});
