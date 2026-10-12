import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  /** Already-translated body text. The one field every call site must supply. */
  message: string;
  /** Already-translated heading; falls back to a generic one. */
  title?: string;
  /** Already-translated label for the affirmative button. */
  confirmLabel?: string;
  /** Already-translated label for the dismissive button. */
  cancelLabel?: string;
  /**
   * `danger` styles the affirmative button as destructive. Use it for
   * anything the user cannot undo — deleting a listing, force-cancelling
   * someone else's order, closing an account.
   */
  variant?: 'primary' | 'danger';
}

export interface ConfirmRequest extends ConfirmOptions {
  readonly id: number;
  readonly settle: (result: boolean) => void;
}

/**
 * Async replacement for `window.confirm()`.
 *
 * `confirm()` returns a boolean inline, so every call site was written as a
 * guard clause (`if (!confirm(...)) return;`). Returning a promise keeps that
 * shape intact — the caller only gains an `await` — which is why this is a
 * promise rather than an observable: an observable would force each of those
 * guards to be turned inside out into a subscribe callback.
 *
 * `unsavedChangesGuard` awaits this too: mobile browsers suppress a native
 * `confirm()` raised during a navigation, and a suppressed one reads as
 * "cancel", which left the page looking frozen.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  /**
   * A queue rather than a single slot: two overlapping asks are rare, but
   * silently resolving the first one as `false` to make room for the second
   * would cancel an action the user never answered.
   */
  private readonly queue = signal<readonly ConfirmRequest[]>([]);
  private nextId = 1;

  /** The request currently on screen, or null when nothing is pending. */
  readonly current = signal<ConfirmRequest | null>(null);

  ask(options: ConfirmOptions | string): Promise<boolean> {
    const opts: ConfirmOptions = typeof options === 'string' ? { message: options } : options;
    return new Promise<boolean>(resolve => {
      const request: ConfirmRequest = { ...opts, id: this.nextId++, settle: resolve };
      this.queue.set([...this.queue(), request]);
      if (!this.current()) this.advance();
    });
  }

  /** Shorthand for the destructive case, which is most of the call sites. */
  askDanger(message: string, extra?: Omit<ConfirmOptions, 'message' | 'variant'>): Promise<boolean> {
    return this.ask({ ...extra, message, variant: 'danger' });
  }

  /** Answers the on-screen request. Called by the dialog host only. */
  settle(id: number, result: boolean): void {
    const request = this.current();
    if (!request || request.id !== id) return;
    this.current.set(null);
    request.settle(result);
    this.advance();
  }

  private advance(): void {
    const [next, ...rest] = this.queue();
    if (!next) return;
    this.queue.set(rest);
    this.current.set(next);
  }
}
