import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiButton } from './button.component';
import { TPipe } from '../../core/i18n.service';

/**
 * The one "this section failed to load" surface.
 *
 * Each section used to hand-roll its own failure branch, and they disagreed:
 * the home categories block got a bordered box with a retry button, the
 * recent-listings block got a bare line of red text with no way to retry, and
 * the home waitlist block had an error branch whose only child was a spinner
 * guarded by `!error` — so on failure it rendered a heading followed by
 * nothing at all. A single component means a failed section can never again
 * be silently empty, and always offers the retry.
 */
@Component({
  selector: 'ui-error-state',
  standalone: true,
  imports: [CommonModule, UiButton, TPipe],
  template: `
    <div class="error-state" role="alert">
      <p class="error-message">{{ message }}</p>
      <ui-button *ngIf="retryable" variant="ghost" size="sm" (onClick)="retry.emit()">
        {{ 'common.retry' | t }}
      </ui-button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-6) var(--space-5);
      text-align: center;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-sm);
      background-color: var(--paper-warm);
    }
    .error-message {
      margin: 0;
      font-size: var(--text-base);
      color: var(--ink-soft);
    }
  `]
})
export class UiErrorState {
  @Input() message: string = '';
  @Input() retryable: boolean = true;
  @Output() retry = new EventEmitter<void>();
}
