import { Component, ChangeDetectorRef, ElementRef, EventEmitter, HostListener, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { isPhoneViewport } from '../../core/viewport';
import { prefersReducedMotion } from '../../core/reduced-motion';

/**
 * Mobile-only pull-to-refresh container.
 *
 * Wraps list content and listens for downward touch drags starting at the very top of
 * the scroll container. When dragged past the ~70px threshold and released, it holds
 * a spinner indicator and emits `(refresh)`.
 *
 * Once the parent's data finishes reloading, setting `[refreshing]="false"` animates
 * the content and indicator back into resting position.
 *
 * On wide screens (>900px) or with mouse interactions, this component is inert.
 */
@Component({
  selector: 'ui-pull-to-refresh',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ptr-host" [class.is-refreshing]="isRefreshing" [class.is-pulling]="isPulling">
      <div
        class="ptr-indicator-area"
        [style.transform]="indicatorTransform"
        [style.opacity]="indicatorOpacity"
        [attr.aria-hidden]="!isRefreshing && pullDistance === 0"
      >
        <div class="ptr-spinner-bubble" [class.spinning]="isRefreshing">
          <svg
            class="ptr-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            [style.transform]="isRefreshing ? null : 'rotate(' + (pullDistance * 4) + 'deg)'"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
        </div>
      </div>
      <div
        class="ptr-content"
        [style.transform]="contentTransform"
        [style.transition]="contentTransition"
      >
        <ng-content></ng-content>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      position: relative;
    }
    .ptr-host {
      position: relative;
      width: 100%;
    }
    .ptr-indicator-area {
      display: none;
    }
    @media (max-width: 900px) {
      :host {
        overscroll-behavior-y: contain;
      }
      .ptr-indicator-area {
        display: flex;
        position: absolute;
        top: -44px;
        left: 0;
        right: 0;
        justify-content: center;
        align-items: center;
        pointer-events: none;
        z-index: 50;
      }
      .ptr-spinner-bubble {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background-color: var(--surface-raised);
        border: 1px solid var(--line-strong);
        box-shadow: var(--shadow-card-lg);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--accent);
      }
      .ptr-icon {
        width: 20px;
        height: 20px;
        transition: transform 0.05s linear;
      }
      .ptr-spinner-bubble.spinning .ptr-icon {
        animation: ptr-spin 0.8s linear infinite;
      }
    }
    @keyframes ptr-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ptr-spinner-bubble.spinning .ptr-icon {
        animation: none;
      }
      .ptr-content {
        transition: none !important;
      }
    }
  `]
})
export class UiPullToRefresh {
  /** Threshold in px to trigger the refresh event on release. */
  private static readonly PULL_THRESHOLD = 70;
  /** Rest distance in px while refreshing is in progress. */
  private static readonly HOLD_DISTANCE = 52;
  /** Maximum pull distance in px with resistance applied. */
  private static readonly MAX_PULL = 110;

  @Input() disabled = false;

  @Input()
  set refreshing(value: boolean) {
    if (!value) {
      this.finishRefresh();
    } else {
      this.isRefreshing = true;
      this.pullDistance = UiPullToRefresh.HOLD_DISTANCE;
      this.cdr.markForCheck();
    }
  }
  get refreshing(): boolean {
    return this.isRefreshing;
  }

  @Output() refresh = new EventEmitter<void>();

  pullDistance = 0;
  isPulling = false;
  isRefreshing = false;

  private touchStartY = 0;
  private touchStartX = 0;
  private canPull = false;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  private cdr = inject(ChangeDetectorRef);
  private hostEl = inject(ElementRef<HTMLElement>);

  get indicatorTransform(): string | null {
    if (this.pullDistance <= 0 && !this.isRefreshing) return null;
    return `translateY(${Math.min(this.pullDistance + 48, 100)}px)`;
  }

  get indicatorOpacity(): number {
    if (this.isRefreshing) return 1;
    return Math.min(1, this.pullDistance / (UiPullToRefresh.PULL_THRESHOLD * 0.7));
  }

  get contentTransform(): string | null {
    if (this.pullDistance <= 0 && !this.isRefreshing) return null;
    return `translateY(${this.pullDistance}px)`;
  }

  get contentTransition(): string | null {
    if (this.isPulling) return 'none';
    if (prefersReducedMotion()) return 'none';
    return 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
  }

  @HostListener('touchstart', ['$event'])
  onTouchStart(event: TouchEvent) {
    if (!isPhoneViewport() || this.disabled || this.isRefreshing) return;
    if (!this.isAtTop(event.target)) return;

    this.touchStartY = event.touches[0].clientY;
    this.touchStartX = event.touches[0].clientX;
    this.canPull = true;
    this.isPulling = false;
  }

  @HostListener('touchmove', ['$event'])
  onTouchMove(event: TouchEvent) {
    if (!this.canPull || !isPhoneViewport() || this.disabled || this.isRefreshing) return;

    const currentY = event.touches[0].clientY;
    const currentX = event.touches[0].clientX;
    const deltaY = currentY - this.touchStartY;
    const deltaX = currentX - this.touchStartX;

    if (!this.isPulling) {
      // Swiping up or sideways: cancel gesture immediately
      if (deltaY <= 0 || Math.abs(deltaX) > Math.abs(deltaY)) {
        this.canPull = false;
        return;
      }
      // Dragging downward from the top edge: engage
      if (deltaY > 6 && this.isAtTop(event.target)) {
        this.isPulling = true;
      }
    }

    if (this.isPulling) {
      if (event.cancelable) {
        event.preventDefault();
      }
      // Linear resistance (50% scale, capped) so extreme drags don't break page flow
      this.pullDistance = Math.min(UiPullToRefresh.MAX_PULL, deltaY * 0.5);
      this.cdr.markForCheck();
    }
  }

  @HostListener('touchend')
  @HostListener('touchcancel')
  onTouchEnd() {
    if (!this.canPull && !this.isPulling) return;
    this.canPull = false;

    if (this.isPulling) {
      this.isPulling = false;
      if (this.pullDistance >= UiPullToRefresh.PULL_THRESHOLD) {
        this.isRefreshing = true;
        this.pullDistance = UiPullToRefresh.HOLD_DISTANCE;
        this.refresh.emit();
      } else {
        this.pullDistance = 0;
      }
      this.cdr.markForCheck();
    }
  }

  private finishRefresh() {
    this.isRefreshing = false;
    this.pullDistance = 0;
    this.cdr.markForCheck();
  }

  /**
   * True only if the page scroll and every scrollable container under the
   * touch point are currently at scrollTop === 0.
   */
  private isAtTop(target: EventTarget | null): boolean {
    if (typeof window === 'undefined') return true;
    const pageY = window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0;
    if (pageY > 0) return false;

    let el = target as HTMLElement | null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollTop > 0) return false;
      el = el.parentElement;
    }
    return true;
  }
}
