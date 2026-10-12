import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService } from '../../core/i18n.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { UiButton } from './button.component';
import { UiFocusTrapDirective } from './focus-trap.directive';

/**
 * Host for `ConfirmService`. Mounted once in the app shell alongside the
 * toast host; pages ask via the service and never render this themselves.
 *
 * `alert()`/`confirm()` got their keyboard behaviour for free from the
 * browser, so all of it has to be rebuilt here or the replacement is a
 * regression: focus enters the dialog on open, cannot Tab out of it while it
 * is up, Esc answers "no", and focus returns to whatever opened it.
 */
@Component({
  selector: 'ui-confirm-dialog',
  standalone: true,
  imports: [CommonModule, UiButton, UiFocusTrapDirective],
  template: `
    @if (confirms.current(); as request) {
      <div class="confirm-overlay" (click)="answer(false)">
        <div
          class="confirm-dialog"
          [uiFocusTrap]="'confirm-title-' + request.id"
          [attr.aria-describedby]="'confirm-message-' + request.id"
          (click)="$event.stopPropagation()"
          (escape)="answer(false)"
        >
          <h2 class="confirm-title" [id]="'confirm-title-' + request.id">
            {{ request.title || defaultTitle }}
          </h2>
          <p class="confirm-message" [id]="'confirm-message-' + request.id">{{ request.message }}</p>
          <div class="confirm-actions">
            <span class="confirm-action">
              <!-- Cancel, not confirm: several call sites are destructive, and a dialog -->
              <!-- that opens with "Delete" pre-focused turns a stray Enter into a deletion. -->
              <ui-button variant="ghost" (onClick)="answer(false)" autofocus>
                {{ request.cancelLabel || defaultCancelLabel }}
              </ui-button>
            </span>
            <span class="confirm-action">
              <ui-button [variant]="request.variant === 'danger' ? 'danger' : 'primary'" (onClick)="answer(true)">
                {{ request.confirmLabel || defaultConfirmLabel }}
              </ui-button>
            </span>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .confirm-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-4);
      background: rgba(0, 0, 0, 0.5);
      animation: confirm-fade 140ms ease-out;
    }
    .confirm-dialog {
      box-sizing: border-box;
      width: 100%;
      max-width: 420px;
      padding: var(--space-5);
      background: var(--surface-raised);
      border: 1px solid var(--surface-raised-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card-lg);
      color: var(--ink);
    }
    .confirm-title {
      margin: 0 0 var(--space-2);
      font-size: var(--text-xl);
      line-height: 1.3;
    }
    .confirm-message {
      margin: 0 0 var(--space-5);
      color: var(--ink-soft);
      font-size: var(--text-base);
      line-height: 1.5;
      overflow-wrap: anywhere;
      white-space: pre-line;
    }
    .confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--space-2);
    }
    /* Narrow phones: two side-by-side buttons with long labels wrap into an
       unreadable stack of fragments, so give each the full width instead. */
    @media (max-width: 380px) {
      .confirm-actions { flex-direction: column-reverse; }
      .confirm-action { width: 100%; }
    }
    @keyframes confirm-fade {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .confirm-overlay { animation: none; }
    }
  `]
})
export class UiConfirmDialog {
  readonly confirms = inject(ConfirmService);
  private readonly i18n = inject(I18nService);

  get defaultTitle(): string {
    return this.i18n.t('common.confirmTitle');
  }

  get defaultConfirmLabel(): string {
    return this.i18n.t('common.confirm');
  }

  get defaultCancelLabel(): string {
    return this.i18n.t('common.cancel');
  }

  answer(result: boolean): void {
    const request = this.confirms.current();
    if (request) this.confirms.settle(request.id, result);
  }
}
