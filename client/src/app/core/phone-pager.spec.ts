import { Subject, of, throwError } from 'rxjs';
import { DestroyRef } from '@angular/core';
import { PhonePager } from './phone-pager';

describe('PhonePager', () => {
  it('initializes with default page 1 and not loading', () => {
    const pager = new PhonePager({
      fetchPage: () => of({ items: [], total: 0 }),
      onAppend: vi.fn(),
    });

    expect(pager.loadedPage).toBe(1);
    expect(pager.loading).toBe(false);
    expect(pager.error).toBe(false);
    expect(pager.hasMore).toBe(false);
  });

  it('determines hasMore using currentCount and total callbacks', () => {
    let count = 10;
    const pager = new PhonePager({
      fetchPage: () => of({ items: [], total: 20 }),
      onAppend: vi.fn(),
      currentCount: () => count,
      total: () => 20,
    });

    expect(pager.hasMore).toBe(true);

    count = 20;
    expect(pager.hasMore).toBe(false);

    count = 25;
    expect(pager.hasMore).toBe(false);
  });

  it('loads the next page, appends items, updates loadedPage, and clears loading', () => {
    let itemsInComponent: string[] = ['a'];
    const fetchPage = vi.fn().mockReturnValue(of({ items: ['b', 'c'], total: 3 }));
    const onAppend = vi.fn((newItems: string[]) => {
      itemsInComponent = [...itemsInComponent, ...newItems];
    });

    const pager = new PhonePager({
      fetchPage,
      onAppend,
      currentCount: () => itemsInComponent.length,
      total: () => 3,
      initialPage: 1,
    });

    expect(pager.hasMore).toBe(true);
    pager.loadMore();

    expect(fetchPage).toHaveBeenCalledWith(2);
    expect(onAppend).toHaveBeenCalledWith(['b', 'c']);
    expect(pager.loadedPage).toBe(2);
    expect(pager.loading).toBe(false);
    expect(pager.error).toBe(false);
    expect(pager.hasMore).toBe(false);
  });

  it('does not load if already loading or hasMore is false', () => {
    const fetchSubject = new Subject<{ items: string[]; total: number }>();
    const fetchPage = vi.fn().mockReturnValue(fetchSubject);

    const pager = new PhonePager({
      fetchPage,
      onAppend: vi.fn(),
      currentCount: () => 5,
      total: () => 10,
    });

    pager.loadMore();
    expect(pager.loading).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // Concurrent call while in flight: should be ignored
    pager.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(1);

    fetchSubject.next({ items: ['x'], total: 10 });
    fetchSubject.complete();

    expect(pager.loading).toBe(false);
  });

  it('handles error and allows retrying the same page', () => {
    const fetchPage = vi.fn()
      .mockReturnValueOnce(throwError(() => new Error('Network error')))
      .mockReturnValueOnce(of({ items: ['recovered'], total: 2 }));
    const onAppend = vi.fn();

    const pager = new PhonePager({
      fetchPage,
      onAppend,
      currentCount: () => 1,
      total: () => 2,
    });

    pager.loadMore();

    expect(pager.loading).toBe(false);
    expect(pager.error).toBe(true);
    expect(pager.loadedPage).toBe(1); // not incremented
    expect(onAppend).not.toHaveBeenCalled();

    // Retry
    pager.loadMore();

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith(2);
    expect(pager.loading).toBe(false);
    expect(pager.error).toBe(false);
    expect(pager.loadedPage).toBe(2);
    expect(onAppend).toHaveBeenCalledWith(['recovered']);
  });

  it('cancels in-flight requests and resets state on reset()', () => {
    const fetchSubject = new Subject<{ items: string[]; total: number }>();
    const onAppend = vi.fn();

    const pager = new PhonePager({
      fetchPage: () => fetchSubject,
      onAppend,
      currentCount: () => 0,
      total: () => 10,
    });

    pager.loadMore();
    expect(pager.loading).toBe(true);

    pager.reset(1);
    expect(pager.loading).toBe(false);
    expect(pager.loadedPage).toBe(1);

    // In-flight response completing after reset must not trigger onAppend
    fetchSubject.next({ items: ['stale'], total: 10 });
    expect(onAppend).not.toHaveBeenCalled();
  });

  it('cancels in-flight request when DestroyRef is destroyed', () => {
    let destroyCallback: (() => void) | undefined;
    const mockDestroyRef = {
      onDestroy: (cb: () => void) => { destroyCallback = cb; }
    } as unknown as DestroyRef;

    const fetchSubject = new Subject<{ items: string[]; total: number }>();
    const onAppend = vi.fn();

    const pager = new PhonePager({
      fetchPage: () => fetchSubject,
      onAppend,
      currentCount: () => 0,
      total: () => 10,
      destroyRef: mockDestroyRef,
    });

    pager.loadMore();
    expect(pager.loading).toBe(true);

    destroyCallback?.();

    fetchSubject.next({ items: ['destroyed'], total: 10 });
    expect(onAppend).not.toHaveBeenCalled();
  });
});
