import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

/**
 * Errors linger roughly twice as long as confirmations: a success toast only
 * has to confirm something the user just did on purpose, while an error is
 * new information they have to read and often act on. Nothing is permanent —
 * every toast is dismissible, and an error that is genuinely blocking belongs
 * inline on the form, not here.
 */
export const TOAST_DURATION_MS: Readonly<Record<ToastKind, number>> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

/**
 * Cap on simultaneously visible toasts. A failing list page can fire one
 * error per row; without a cap the stack grows until it covers the page and
 * becomes the same modal blocker `alert()` was.
 */
export const TOAST_MAX_VISIBLE = 4;

/**
 * Non-blocking replacement for `window.alert()`.
 *
 * The state lives in a service rather than in each page because the host that
 * renders it is mounted once in the app shell — a page that navigates away
 * mid-request should not take its own feedback down with it.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly items = signal<readonly Toast[]>([]);
  readonly toasts = this.items.asReadonly();

  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  success(message: unknown, durationMs?: number): number {
    return this.show('success', message, durationMs);
  }

  error(message: unknown, durationMs?: number): number {
    return this.show('error', message, durationMs);
  }

  info(message: unknown, durationMs?: number): number {
    return this.show('info', message, durationMs);
  }

  show(kind: ToastKind, message: unknown, durationMs = TOAST_DURATION_MS[kind]): number {
    // Call sites inherited from `alert()` habitually pass whatever the API
    // handed back (`err.error?.error || t('...')`), which is not always a
    // string. `alert()` stringified it for them; this has to do the same or
    // the toast renders "[object Object]" — or nothing at all.
    const text = ToastService.toText(message);
    if (!text) return 0;

    const id = this.nextId++;
    const next = [...this.items(), { id, kind, message: text }];
    // Drop from the front: the oldest toast has had the most reading time.
    const overflow = next.length - TOAST_MAX_VISIBLE;
    if (overflow > 0) {
      for (const dropped of next.slice(0, overflow)) this.clearTimer(dropped.id);
    }
    this.items.set(overflow > 0 ? next.slice(overflow) : next);

    if (durationMs > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), durationMs));
    }
    return id;
  }

  dismiss(id: number): void {
    this.clearTimer(id);
    this.items.set(this.items().filter(t => t.id !== id));
  }

  clear(): void {
    for (const t of this.items()) this.clearTimer(t.id);
    this.items.set([]);
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private static toText(message: unknown): string {
    if (message === null || message === undefined) return '';
    if (typeof message === 'string') return message.trim();
    if (typeof message === 'number' || typeof message === 'boolean') return String(message);
    // An error-shaped object: prefer whatever field actually reads as prose.
    const candidate = (message as any).detail ?? (message as any).message ?? (message as any).error;
    return typeof candidate === 'string' ? candidate.trim() : '';
  }
}
