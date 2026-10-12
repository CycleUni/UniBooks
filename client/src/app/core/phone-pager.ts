import { ChangeDetectorRef, DestroyRef } from '@angular/core';
import { Observable, Subscription } from 'rxjs';

export interface PhonePagerConfig<T> {
  /**
   * Fetches a 1-indexed page from the backend, returning the newly retrieved
   * items and the known total count of items.
   */
  fetchPage: (page: number) => Observable<{ items: T[]; total: number }>;
  /**
   * Callback invoked whenever a new page is retrieved to append items to
   * the component's existing list.
   */
  onAppend: (items: T[]) => void;
  /** Function returning the current count of loaded items on the client. */
  currentCount?: () => number;
  /** Function returning the total count of items across all pages. */
  total?: () => number;
  /** Change detector to mark for check when paging state transitions. */
  cdr?: ChangeDetectorRef;
  /** DestroyRef to automatically cancel in-flight page requests upon view destruction. */
  destroyRef?: DestroyRef;
  /** Initial page index (defaults to 1). */
  initialPage?: number;
}

/**
 * Encapsulates the common phone infinite-scroll pagination logic across
 * search, book listings, seller listings, and user listings.
 *
 * Keeps track of whether more items can be loaded, coordinates next-page
 * fetches, manages error and loading states, and cancels in-flight requests
 * on reset or component destruction.
 */
export class PhonePager<T> {
  loading = false;
  error = false;
  loadedPage: number;
  private currentTotal = 0;
  private sub?: Subscription;

  constructor(private readonly config: PhonePagerConfig<T>) {
    this.loadedPage = config.initialPage ?? 1;
    config.destroyRef?.onDestroy(() => this.cancel());
  }

  get hasMore(): boolean {
    const total = this.config.total ? this.config.total() : this.currentTotal;
    const count = this.config.currentCount ? this.config.currentCount() : 0;
    return count < total;
  }

  loadMore(): void {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    this.error = false;
    this.notify();

    const nextPage = this.loadedPage + 1;
    this.sub = this.config.fetchPage(nextPage).subscribe({
      next: ({ items, total }) => {
        this.currentTotal = total;
        this.config.onAppend(items);
        this.loadedPage = nextPage;
        this.loading = false;
        this.error = false;
        this.notify();
      },
      error: () => {
        this.loading = false;
        this.error = true;
        this.notify();
      }
    });
  }

  reset(page: number = 1, total?: number): void {
    this.cancel();
    this.loadedPage = page;
    if (total !== undefined) {
      this.currentTotal = total;
    }
    this.loading = false;
    this.error = false;
    this.notify();
  }

  cancel(): void {
    if (this.sub) {
      this.sub.unsubscribe();
      this.sub = undefined;
    }
  }

  private notify(): void {
    this.config.cdr?.markForCheck();
  }
}
