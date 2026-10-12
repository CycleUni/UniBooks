import { ChangeDetectorRef, inject } from '@angular/core';
import { Observable, catchError, from, map, mergeMap, of, toArray } from 'rxjs';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService } from '../../core/i18n.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * The rows ticked on an admin list. Holds ids, not rows, so a reload that
 * brings back the same rows as new objects would keep them ticked; the lists
 * clear it on reload anyway, so a tick never outlives the page it was on.
 */
export class RowSelection<K extends string | number> {
  private ids = new Set<K>();

  get size(): number {
    return this.ids.size;
  }

  get list(): K[] {
    return [...this.ids];
  }

  has(id: K): boolean {
    return this.ids.has(id);
  }

  toggle(id: K): void {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
  }

  /** Every one of `ids` is ticked (and there is at least one). */
  allOf(ids: K[]): boolean {
    return ids.length > 0 && ids.every((id) => this.ids.has(id));
  }

  /** Ticks every one of `ids`, or unticks them all when they already are. */
  toggleAll(ids: K[]): void {
    this.ids = new Set(this.allOf(ids) ? [] : ids);
  }

  clear(): void {
    this.ids = new Set();
  }
}

export interface BulkResult<K> {
  done: K[];
  failed: { id: K; error: unknown }[];
}

/**
 * Runs `action` for each id, a few at a time, through the same endpoint the
 * row's own page uses, so every check and audit record of the single action
 * applies to each. One failure does not stop the others.
 */
export function runBulk<K>(
  ids: K[],
  action: (id: K) => Observable<unknown>,
  concurrency = 4,
): Observable<BulkResult<K>> {
  return from(ids).pipe(
    mergeMap(
      (id) =>
        action(id).pipe(
          map(() => ({ id, ok: true as const, error: null as unknown })),
          catchError((error) => of({ id, ok: false as const, error })),
        ),
      concurrency,
    ),
    toArray(),
    map((outcomes) => ({
      done: outcomes.filter((o) => o.ok).map((o) => o.id),
      failed: outcomes.filter((o) => !o.ok).map(({ id, error }) => ({ id, error })),
    })),
  );
}

/** Tells the admin how a bulk action went: a count, or what failed and why. */
export function reportBulk(
  toast: ToastService,
  i18n: I18nService,
  result: BulkResult<unknown>,
): void {
  if (!result.failed.length) {
    toast.success(i18n.t('admin.bulk.done', { n: result.done.length }));
    return;
  }
  toast.error(
    i18n.t('admin.bulk.partial', {
      done: result.done.length,
      failed: result.failed.length,
      reason: parseAdminError(result.failed[0].error, i18n, 'admin.errGeneric'),
    }),
  );
}

/** What a bulk action asks before it runs. Texts arrive translated. */
export interface BulkAsk {
  /** Body of the confirmation dialog; the action runs without one if unset. */
  confirm?: string;
  /** A red confirm button, for what cannot be undone. */
  danger?: boolean;
  /** The confirm button's label: the action's own name. */
  confirmLabel?: string;
}

/** The reason dialog a bulk action opens before it runs. */
export interface BulkReasonPrompt {
  title: string;
  message: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  minLength: number;
  danger: boolean;
  run: (reason: string) => void;
}

/**
 * Selection and bulk actions of one admin list. Created in a component's
 * field initialiser, where it can inject what it needs; `reload` refreshes
 * the list after an action, which also clears the selection.
 */
export class BulkController<K extends string | number> {
  readonly selection = new RowSelection<K>();
  /** A bulk action is running. */
  busy = false;
  /** The reason dialog on screen, if any. */
  reasonPrompt: BulkReasonPrompt | null = null;

  private toast = inject(ToastService);
  private i18n = inject(I18nService);
  private confirms = inject(ConfirmService);
  private cdr = inject(ChangeDetectorRef);

  constructor(private reload: () => void) {}

  /** Runs `action` for every ticked row, after `ask`'s confirmation. */
  async run(action: (id: K) => Observable<unknown>, ask: BulkAsk = {}): Promise<void> {
    const ids = this.selection.list;
    if (!ids.length || this.busy) return;
    if (ask.confirm && !(await this.confirm(ask))) return;
    this.busy = true;
    this.cdr.markForCheck();
    runBulk(ids, action).subscribe((result) => {
      this.busy = false;
      reportBulk(this.toast, this.i18n, result);
      this.reload();
      this.cdr.markForCheck();
    });
  }

  /**
   * Like `run`, for an endpoint that takes every ticked id in one request
   * and answers with those it changed; the rest are reported as skipped.
   */
  async runBatch(action: (ids: K[]) => Observable<K[]>, ask: BulkAsk = {}): Promise<void> {
    const ids = this.selection.list;
    if (!ids.length || this.busy) return;
    if (ask.confirm && !(await this.confirm(ask))) return;
    this.busy = true;
    this.cdr.markForCheck();
    action(ids).subscribe({
      next: (changed) => {
        this.busy = false;
        const skipped = ids.length - changed.length;
        if (skipped > 0) this.toast.info(this.i18n.t('admin.bulk.doneSkipped', { n: changed.length, skipped }));
        else this.toast.success(this.i18n.t('admin.bulk.done', { n: changed.length }));
        this.reload();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.busy = false;
        this.toast.error(parseAdminError(err, this.i18n, 'admin.errSaveFailed'));
        this.cdr.markForCheck();
      },
    });
  }

  /** Asks for one reason, then runs `action` with it for every ticked row. */
  runWithReason(prompt: Omit<BulkReasonPrompt, 'run'>, action: (id: K, reason: string) => Observable<unknown>): void {
    if (!this.selection.size || this.busy) return;
    this.reasonPrompt = {
      ...prompt,
      run: (reason) => {
        this.reasonPrompt = null;
        this.run((id) => action(id, reason));
      },
    };
  }

  private confirm(ask: BulkAsk): Promise<boolean> {
    return this.confirms.ask({
      message: ask.confirm!,
      variant: ask.danger ? 'danger' : 'primary',
      confirmLabel: ask.confirmLabel,
    });
  }

  /** Clears the ticks; the lists call it whenever they load a page. */
  reset(): void {
    this.selection.clear();
    this.reasonPrompt = null;
  }
}
