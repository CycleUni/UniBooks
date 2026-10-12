import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService } from '../../core/i18n.service';
import { Toast, ToastService } from '../../core/services/toast.service';

/**
 * Renders the app-wide toast stack. Mounted once in the app shell — see
 * `App`'s template for why it sits beside the layout rather than inside it.
 *
 * Two live regions, not one, and both are in the DOM from the first render:
 * a live region only announces nodes inserted *into* it, so a container
 * created at the same moment as its message is frequently missed entirely.
 * Splitting them by urgency is the point — `alert()` was rude but it was also
 * unmissable, and replacing it with a purely visual popup would be a net loss
 * for screen-reader users. Errors interrupt (assertive); confirmations wait
 * for a pause in speech (polite).
 *
 * The assertive region is rendered first so errors stack *above* the quieter
 * toasts, keeping the most urgent message furthest from the screen edge where
 * it is least likely to be clipped by the tab bar or a system gesture area.
 */
@Component({
  selector: 'ui-toast-host',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-host">
      <div class="toast-region" role="alert" aria-live="assertive">
        <div *ngFor="let toast of urgent(); trackBy: trackById" class="toast error">
          <ng-container *ngTemplateOutlet="body; context: { $implicit: toast }"></ng-container>
        </div>
      </div>
      <div class="toast-region" role="status" aria-live="polite">
        <div *ngFor="let toast of quiet(); trackBy: trackById" [class]="'toast ' + toast.kind">
          <ng-container *ngTemplateOutlet="body; context: { $implicit: toast }"></ng-container>
        </div>
      </div>
    </div>

    <ng-template #body let-toast>
      <span class="toast-icon" aria-hidden="true">{{ icon(toast.kind) }}</span>
      <span class="toast-text">{{ toast.message }}</span>
      <button
        type="button"
        class="toast-close"
        [attr.aria-label]="dismissLabel"
        (click)="toasts.dismiss(toast.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18"/>
        </svg>
      </button>
    </ng-template>
  `,
  styles: [`
    /* The host itself must not swallow clicks on the page underneath it: it
       spans the full width so the stack can be centred on small screens, and
       only the toasts themselves are interactive. */
    .toast-host {
      position: fixed;
      left: 0;
      right: 0;
      bottom: var(--space-5);
      z-index: 9998;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-2);
      padding-inline: var(--space-4);
      pointer-events: none;
    }
    .toast-region {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-2);
      width: 100%;
    }
    /* An empty live region must stay in the DOM (see the class comment) but
       must not occupy a gap in the stack while it holds nothing. */
    .toast-region:empty {
      display: none;
    }
    .toast {
      pointer-events: auto;
      box-sizing: border-box;
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      max-width: 420px;
      padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-control);
      box-shadow: var(--shadow-card-lg);
      /* A toast floats over the page rather than sitting on it. */
      background-color: var(--surface-raised);
      color: var(--ink);
      font-size: var(--text-sm);
      line-height: 1.45;
      animation: toast-in 180ms ease-out;
    }
    /* Same status vocabulary as .inline-msg / .alert-box: tinted ground plus
       the matching ink, both theme-resolved tokens. */
    .toast.success {
      background-color: var(--success-light);
      border-color: var(--success);
      color: var(--success);
    }
    .toast.error {
      background-color: var(--danger-light);
      border-color: var(--danger);
      color: var(--danger);
    }
    .toast.info {
      background-color: var(--info-bg);
      border-color: var(--info-border);
      color: var(--info-ink);
    }
    .toast-icon {
      flex: none;
      font-weight: 700;
      line-height: 1.45;
    }
    .toast-text {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .toast-close {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      margin: -2px 0 0 0;
      padding: 0;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      color: inherit;
      opacity: 0.75;
      cursor: pointer;
    }
    .toast-close:hover {
      opacity: 1;
    }
    @keyframes toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast { animation: none; }
    }
    /* 900px is where .bottom-tab-bar appears (layout.component.css keys every
       clearance off the same breakpoint); a toast pinned to the viewport
       bottom would otherwise sit on top of the only navigation on mobile. */
    @media (max-width: 900px) {
      .toast-host {
        bottom: calc(var(--space-3) + 56px + env(safe-area-inset-bottom, 0px));
        align-items: stretch;
      }
      .toast-region { align-items: stretch; }
      .toast { max-width: none; }
    }
  `]
})
export class UiToastHost {
  readonly toasts = inject(ToastService);
  private readonly i18n = inject(I18nService);

  readonly urgent = computed(() => this.toasts.toasts().filter(t => t.kind === 'error'));
  readonly quiet = computed(() => this.toasts.toasts().filter(t => t.kind !== 'error'));

  get dismissLabel(): string {
    return this.i18n.t('common.dismiss');
  }

  icon(kind: Toast['kind']): string {
    return kind === 'success' ? '✓' : kind === 'error' ? '✕' : 'ℹ';
  }

  trackById(_index: number, toast: Toast): number {
    return toast.id;
  }
}
