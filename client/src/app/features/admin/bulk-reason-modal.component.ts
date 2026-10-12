import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiTextarea } from '../../shared/ui/textarea.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { TPipe } from '../../core/i18n.service';

/**
 * Asks once for the written reason a bulk action gives every row it acts
 * on: a force-cancel, a listing deleted with open orders, a lock. Only
 * collects it; the list runs the action. The texts arrive translated.
 */
@Component({
  selector: 'admin-bulk-reason-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiTextarea, TPipe, UiFocusTrapDirective],
  template: `
    <div class="app-modal-overlay" (click)="closed.emit()">
      <form
        class="app-modal w-full"
        style="max-width: 420px;"
        (click)="$event.stopPropagation()"
        (ngSubmit)="submit()"
        uiFocusTrap="bulk-reason-title"
        (escape)="closed.emit()"
      >
        <h3 id="bulk-reason-title" class="app-modal-title">{{ title }}</h3>
        <div class="app-modal-body">
          <p class="hint">{{ message }}</p>
          <label class="field">
            <span>{{ label }}</span>
            <ui-textarea
              name="reason"
              [(ngModel)]="reason"
              [placeholder]="placeholder"
            ></ui-textarea>
          </label>
          <small *ngIf="minLength && reason.trim().length < minLength" class="hint">{{
            'admin.bulk.reasonMin' | t: { n: minLength }
          }}</small>
        </div>
        <div class="app-modal-actions">
          <ui-button variant="ghost" (onClick)="closed.emit()">{{ 'common.cancel' | t }}</ui-button>
          <ui-button
            type="submit"
            [variant]="danger ? 'danger' : 'primary'"
            [disabled]="reason.trim().length < minLength"
            >{{ submitLabel }}</ui-button
          >
        </div>
      </form>
    </div>
  `,
  styles: [
    `
      .hint {
        margin: 0 0 12px;
        color: var(--ink-soft);
        font-size: var(--text-sm);
      }
      small.hint {
        display: block;
        margin: 4px 0 0;
        color: var(--muted);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-weight: 500;
        color: var(--ink);
      }
    `,
  ],
})
export class AdminBulkReasonModalComponent {
  @Input() title = '';
  @Input() message = '';
  @Input() label = '';
  @Input() placeholder = '';
  @Input() submitLabel = '';
  /** Shortest reason accepted; 0 lets it be left empty. */
  @Input() minLength = 0;
  @Input() danger = false;
  @Output() submitted = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  reason = '';

  submit() {
    const reason = this.reason.trim();
    if (reason.length < this.minLength) return;
    this.submitted.emit(reason);
  }
}
