import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
  ChangeDetectorRef,
  inject,
  NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';
import { isPhoneViewport, watchPhoneViewport } from '../../core/viewport';

/**
 * Mobile-only infinite scroll sentinel.
 *
 * Sits at the bottom of a list on phone screens and watches for when the user
 * scrolls near the end. When visible, it emits `loadMore` to fetch and append the
 * next page of results. Shows a small loading spinner while fetching, and a retry
 * button if an error occurs.
 *
 * Does nothing on desktop screens, where `ui-pagination` remains active.
 */
@Component({
  selector: 'ui-infinite-scroll',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <div class="infinite-scroll-container" *ngIf="isPhone">
      <div class="sentinel" #sentinel *ngIf="hasMore && !error"></div>

      <div class="infinite-loading-row" *ngIf="loading" role="status" [attr.aria-label]="'common.loading' | t">
        <span class="infinite-spinner" aria-hidden="true"></span>
        <span class="loading-label">{{ 'common.loading' | t }}</span>
      </div>

      <div class="infinite-error-row" *ngIf="error">
        <span class="error-label">{{ 'common.error' | t }}</span>
        <button type="button" class="retry-button" (click)="onRetry()">
          {{ 'common.retry' | t }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: none;
    }
    @media (max-width: 900px) {
      :host {
        display: block;
        width: 100%;
      }
      .infinite-scroll-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-block: var(--space-4);
        width: 100%;
        box-sizing: border-box;
      }
      .sentinel {
        width: 100%;
        height: 1px;
        pointer-events: none;
      }
      .infinite-loading-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--muted);
        font-size: var(--text-sm);
        padding: 8px 0;
      }
      .infinite-spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid var(--line);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: infinite-spin 0.7s linear infinite;
      }
      .infinite-error-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        color: var(--danger);
        font-size: var(--text-sm);
        padding: 8px 0;
      }
      .retry-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 4px 12px;
        border: 1px solid var(--line-strong);
        border-radius: var(--radius-control);
        background: var(--paper);
        color: var(--ink);
        font-size: var(--text-sm);
        font-weight: 500;
        cursor: pointer;
        transition: background-color var(--motion-base), border-color var(--motion-base);
      }
      .retry-button:active {
        background-color: var(--paper-warm);
        border-color: var(--ink);
      }
    }
    @keyframes infinite-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .infinite-spinner {
        animation: none;
      }
    }
  `]
})
export class UiInfiniteScroll implements OnInit, OnChanges, OnDestroy {
  @Input() loading = false;
  @Input() hasMore = false;
  @Input() error = false;
  @Input() disabled = false;

  /** The next page is wanted: the end is near, or the retry was tapped. */
  @Output() loadMore = new EventEmitter<void>();

  @ViewChild('sentinel') set sentinelRef(el: ElementRef<HTMLElement> | undefined) {
    this.sentinelEl = el?.nativeElement;
    this.updateObserver();
  }

  isPhone = isPhoneViewport();

  private sentinelEl?: HTMLElement;
  private observer?: IntersectionObserver;
  private unwatchPhone?: () => void;

  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  ngOnInit() {
    this.unwatchPhone = watchPhoneViewport((isPhone) => {
      this.isPhone = isPhone;
      this.updateObserver();
      this.cdr.markForCheck();
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['loading'] || changes['hasMore'] || changes['error'] || changes['disabled']) {
      this.updateObserver();
    }
  }

  ngOnDestroy() {
    this.unwatchPhone?.();
    this.observer?.disconnect();
  }

  onRetry() {
    this.loadMore.emit();
  }

  private updateObserver() {
    this.observer?.disconnect();
    if (!this.isPhone || !this.hasMore || this.loading || this.error || this.disabled) return;
    if (!this.sentinelEl || typeof IntersectionObserver === 'undefined') return;

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.zone.run(() => {
            if (this.isPhone && this.hasMore && !this.loading && !this.error && !this.disabled) {
              this.loadMore.emit();
            }
          });
        }
      },
      { rootMargin: '200px 0px', threshold: 0 }
    );

    this.observer.observe(this.sentinelEl);
  }
}
