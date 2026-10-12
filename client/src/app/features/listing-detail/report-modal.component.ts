import { ChangeDetectorRef, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiTextarea } from '../../shared/ui/textarea.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { ListingService } from '../../core/services/listing.service';
import { I18nService, TPipe } from '../../core/i18n.service';

/**
 * Modal for reporting a listing, structured like review-modal.component.ts
 * (modal-overlay + modal-content, @Input listingId, close/submitted events).
 */
@Component({
  selector: 'app-report-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiDropdown, UiTextarea, TPipe, UiFocusTrapDirective],
  template: `
    <div class="modal-overlay" (click)="close()"></div>
    <div class="modal-content" uiFocusTrap="listing-report-title" (escape)="close()">
      <h3 id="listing-report-title">{{ 'moderation.reportModalTitle' | t }}</h3>

      <ui-dropdown
        [label]="'moderation.reasonLabel' | t"
        [options]="reasonOptions"
        [(ngModel)]="reason"
       [searchable]="false" [appendToBody]="true"></ui-dropdown>

      <div class="textarea-wrapper">
        <label>{{ 'moderation.detailLabel' | t }}</label>
        <ui-textarea [(ngModel)]="detail" [placeholder]="'moderation.detailPlaceholder' | t"></ui-textarea>
      </div>

      <div *ngIf="errorMsg" class="inline-msg error">
        {{ errorMsg }}
      </div>

      <div class="actions mt-5"  style="display: flex; justify-content: flex-end; gap: 8px;">
        <ui-button variant="ghost" (onClick)="close()" [disabled]="isSubmitting">{{ 'common.cancel' | t }}</ui-button>
        <ui-button (onClick)="submit()" [disabled]="isSubmitting">
          {{ isSubmitting ? ('moderation.submitting' | t) : ('moderation.submit' | t) }}
        </ui-button>
      </div>
    </div>
  `,
  styles: [`
    :host {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
    }
    .modal-content {
      position: relative;
      background: var(--surface-raised);
      padding: 24px;
      border-radius: 8px;
      width: 100%;
      max-width: 400px;
      z-index: 1001;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    h3 { margin-top: 0; margin-bottom: 12px; }
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
export class ReportModalComponent {
  @Input() listingId!: string;
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  reason: 'fake' | 'scam' | 'other' = 'fake';
  detail = '';
  isSubmitting = false;
  errorMsg = '';

  private listingService = inject(ListingService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  get reasonOptions() {
    return [
      { value: 'fake', label: this.i18n.t('moderation.reasonFake') },
      { value: 'scam', label: this.i18n.t('moderation.reasonScam') },
      { value: 'other', label: this.i18n.t('moderation.reasonOther') },
    ];
  }

  close() {
    this.closed.emit();
  }

  submit() {
    this.isSubmitting = true;
    this.errorMsg = '';

    this.listingService.reportListing(this.listingId, this.reason, this.detail).subscribe({
      next: () => {
        this.isSubmitting = false;
        this.submitted.emit();
      },
      error: (err) => {
        this.isSubmitting = false;
        const code = err?.error?.error?.code;
        if (code === 'moderation.errCannotReportOwnListing' || code === 'moderation.errAlreadyReported') {
          this.errorMsg = this.i18n.t(code);
        } else {
          this.errorMsg = this.i18n.t('moderation.errGeneric');
        }
        // The answer lands outside any event here; under OnPush (Angular's
        // default) the error and the re-enabled button stayed unrendered.
        this.cdr.markForCheck();
      }
    });
  }
}
