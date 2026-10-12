import { parseAdminError } from '../../core/admin-error.util';
import { ChangeDetectorRef, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiTextarea } from '../../shared/ui/textarea.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { AdminService } from '../../core/services/admin.service';
import { I18nService, TPipe } from '../../core/i18n.service';

// Structural clone of report-modal.component.ts.
@Component({
  selector: 'app-force-cancel-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiTextarea, TPipe, UiFocusTrapDirective],
  template: `
    <div class="app-modal-overlay" (click)="close()">
      <div class="app-modal w-full"  style="max-width: 400px;" (click)="$event.stopPropagation()" uiFocusTrap="force-cancel-title" (escape)="close()">
        <h3 id="force-cancel-title" class="app-modal-title">{{ (listingId ? 'admin.deleteWithOrdersTitle' : 'admin.forceCancelTitle') | t }}</h3>

        <div class="app-modal-body">
          <p *ngIf="listingId" class="hint">{{ 'admin.deleteWithOrdersHint' | t:{count: openOrders} }}</p>
          <div class="textarea-wrapper">
            <label>{{ 'admin.forceCancelReasonLabel' | t }}</label>
            <ui-textarea [(ngModel)]="reason" [placeholder]="'admin.forceCancelReasonPlaceholder' | t"></ui-textarea>
          </div>

          <div *ngIf="errorMsg" class="inline-msg error">
            {{ errorMsg }}
          </div>
        </div>

        <div class="app-modal-actions">
          <ui-button variant="ghost" (onClick)="close()" [disabled]="isSubmitting">{{ 'common.cancel' | t }}</ui-button>
          <ui-button (onClick)="submit()" [disabled]="isSubmitting || reason.trim().length < 3">
            {{ isSubmitting ? ('admin.saving' | t) : ((listingId ? 'common.delete' : 'admin.forceCancelSubmit') | t) }}
          </ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    h3 { margin-top: 0; margin-bottom: 12px; }
    .hint { margin: 0 0 12px; color: var(--ink-soft); font-size: var(--text-sm); }
    .textarea-wrapper {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .textarea-wrapper label {
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--ink);
    }
  `]
})
export class ForceCancelModalComponent {
  @Input() orderId?: string;
  /**
   * Deleting a listing that still has open orders: the platform cancels them
   * first, with the same written reason a force-cancel takes, so this modal
   * collects it and sends the delete instead.
   */
  @Input() listingId?: string;
  @Input() openOrders = 0;
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  reason = '';
  isSubmitting = false;
  errorMsg = '';

  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  close() {
    this.closed.emit();
  }

  submit() {
    this.isSubmitting = true;
    this.errorMsg = '';

    const request: Observable<unknown> = this.listingId
      ? this.adminService.deleteListing(this.listingId, this.reason.trim())
      : this.adminService.forceCancelOrder(this.orderId!, this.reason.trim());
    request.subscribe({
      next: () => {
        this.isSubmitting = false;
        this.submitted.emit();
      },
      error: (err) => {
        this.isSubmitting = false;
        const code = err?.error?.error?.code;
        if (code === 'admin.errOrderAlreadyFinal') {
          this.errorMsg = this.i18n.t(code);
        } else {
          this.errorMsg = parseAdminError(err, this.i18n, 'admin.errGeneric');
        }
        // As in report-modal: the answer lands outside any event here.
        this.cdr.markForCheck();
      }
    });
  }
}
