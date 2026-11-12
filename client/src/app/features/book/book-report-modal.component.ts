import { ChangeDetectorRef, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiTextarea } from '../../shared/ui/textarea.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { BookService } from '../../core/services/book.service';
import { ToastService } from '../../core/services/toast.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { LIMITS } from '../../core/limits';

export interface BookReportFieldConfig {
  key: 'title' | 'authors' | 'publisher' | 'published_date' | 'cover' | 'isbn' | 'other';
  labelKey: string;
  hasSuggestedInput: boolean;
  suggestedPlaceholderKey?: string;
  maxLength?: number;
}

export const BOOK_REPORT_FIELDS_CONFIG: BookReportFieldConfig[] = [
  { key: 'title', labelKey: 'bookReport.fieldTitle', hasSuggestedInput: true, suggestedPlaceholderKey: 'bookReport.suggestedTitle', maxLength: LIMITS.bookTitle },
  { key: 'authors', labelKey: 'bookReport.fieldAuthors', hasSuggestedInput: true, suggestedPlaceholderKey: 'bookReport.suggestedAuthors', maxLength: LIMITS.bookAuthors },
  { key: 'publisher', labelKey: 'bookReport.fieldPublisher', hasSuggestedInput: true, suggestedPlaceholderKey: 'bookReport.suggestedPublisher', maxLength: LIMITS.bookPublisher },
  { key: 'published_date', labelKey: 'bookReport.fieldPublishedDate', hasSuggestedInput: true, suggestedPlaceholderKey: 'bookReport.suggestedPublishedDate', maxLength: LIMITS.bookPublishedDate },
  { key: 'cover', labelKey: 'bookReport.fieldCover', hasSuggestedInput: true, suggestedPlaceholderKey: 'bookReport.suggestedCover', maxLength: 1024 },
  { key: 'isbn', labelKey: 'bookReport.fieldIsbn', hasSuggestedInput: true, suggestedPlaceholderKey: 'bookReport.suggestedIsbn', maxLength: 17 },
  { key: 'other', labelKey: 'bookReport.fieldOther', hasSuggestedInput: false },
];

@Component({
  selector: 'app-book-report-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiTextarea, TPipe, UiFocusTrapDirective],
  template: `
    <div class="modal-overlay" (click)="close()"></div>
    <div class="modal-content" uiFocusTrap="book-report-title" (escape)="close()">
      <h3 id="book-report-title">{{ 'bookReport.modalTitle' | t }}</h3>
      <p class="modal-subtitle" *ngIf="bookTitle">{{ bookTitle }}</p>

      <div *ngIf="alreadyReported" class="already-reported-card" role="alert">
        <p class="already-reported-text">{{ 'bookReport.alreadyReported' | t }}</p>
        <div class="actions">
          <ui-button variant="primary" size="sm" (onClick)="close()">{{ 'common.cancel' | t }}</ui-button>
        </div>
      </div>

      <form *ngIf="!alreadyReported" (ngSubmit)="submit()" novalidate>
        <div class="form-section">
          <label class="section-label">{{ 'bookReport.fieldsLabel' | t }}</label>
          <div class="field-checkboxes">
            <div *ngFor="let f of fieldsConfig" class="field-item">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  [checked]="selectedFields.has(f.key)"
                  (change)="toggleField(f.key)"
                />
                <span class="field-name">{{ f.labelKey | t }}</span>
              </label>

              <div *ngIf="f.hasSuggestedInput && selectedFields.has(f.key)" class="suggested-input-row">
                <input
                  type="text"
                  class="suggested-input"
                  [placeholder]="(f.suggestedPlaceholderKey || '') | t"
                  [maxlength]="f.maxLength || 255"
                  [(ngModel)]="suggested[f.key]"
                  [name]="'suggested_' + f.key"
                />
              </div>
            </div>
          </div>
          <small *ngIf="noFieldSelectedError" class="field-error" role="alert">
            {{ 'bookReport.fieldsRequired' | t }}
          </small>
        </div>

        <div class="textarea-wrapper">
          <label class="section-label">
            {{ 'bookReport.detailLabel' | t }}
            <span *ngIf="selectedFields.has('other')" class="required-mark">*</span>
          </label>
          <ui-textarea
            [(ngModel)]="detail"
            name="detail"
            [placeholder]="'bookReport.detailPlaceholder' | t"
            [maxlength]="LIMITS.bookReportDetail"
            [showCounter]="true"
          ></ui-textarea>
          <small *ngIf="detailRequiredError" class="field-error" role="alert">
            {{ 'bookReport.detailRequired' | t }}
          </small>
        </div>

        <div *ngIf="errorMsg" class="inline-msg error" role="alert">
          {{ errorMsg }}
        </div>

        <div class="actions">
          <ui-button variant="ghost" type="button" (onClick)="close()" [disabled]="isSubmitting">
            {{ 'common.cancel' | t }}
          </ui-button>
          <ui-button variant="primary" type="submit" [disabled]="isSubmitting || selectedFields.size === 0">
            {{ (isSubmitting ? 'bookReport.submitting' : 'bookReport.submit') | t }}
          </ui-button>
        </div>
      </form>
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
      padding: 16px;
    }
    .modal-overlay {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.5);
    }
    .modal-content {
      position: relative;
      background: var(--surface-raised);
      padding: 24px;
      border-radius: 8px;
      width: 100%;
      max-width: 520px;
      max-height: 90vh;
      overflow-y: auto;
      z-index: 1001;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    }
    h3 {
      margin-top: 0;
      margin-bottom: 4px;
      font-size: var(--text-lg);
      color: var(--ink);
    }
    .modal-subtitle {
      margin: 0 0 16px;
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .form-section {
      margin-bottom: 16px;
    }
    .section-label {
      display: block;
      font-size: var(--text-base);
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--ink);
    }
    .required-mark {
      color: var(--danger);
    }
    .field-checkboxes {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .field-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: var(--text-base);
      color: var(--ink);
    }
    .suggested-input-row {
      margin-left: 24px;
    }
    .suggested-input {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      font-size: var(--text-sm);
      background: var(--paper-warm);
      color: var(--ink);
    }
    .textarea-wrapper {
      margin-bottom: 16px;
    }
    .field-error {
      color: var(--danger);
      font-size: var(--text-xs);
      display: block;
      margin-top: 4px;
    }
    .inline-msg.error {
      color: var(--danger);
      background: var(--danger-bg, #fee2e2);
      padding: 8px 12px;
      border-radius: 4px;
      margin-bottom: 16px;
      font-size: var(--text-sm);
    }
    .already-reported-card {
      padding: 16px;
      background: var(--paper-warm);
      border: 1px solid var(--line);
      border-radius: 6px;
      text-align: center;
    }
    .already-reported-text {
      margin: 0 0 16px;
      color: var(--ink);
      font-size: var(--text-base);
      line-height: 1.5;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
  `],
})
export class BookReportModalComponent {
  readonly LIMITS = LIMITS;
  readonly fieldsConfig = BOOK_REPORT_FIELDS_CONFIG;

  @Input({ required: true }) bookId!: string;
  @Input() bookTitle = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  selectedFields = new Set<string>();
  suggested: Record<string, string> = {};
  detail = '';

  isSubmitting = false;
  alreadyReported = false;
  noFieldSelectedError = false;
  detailRequiredError = false;
  errorMsg = '';

  private bookService = inject(BookService);
  private toast = inject(ToastService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  toggleField(field: string) {
    const next = new Set(this.selectedFields);
    if (next.has(field)) {
      next.delete(field);
      delete this.suggested[field];
    } else {
      next.add(field);
    }
    this.selectedFields = next;
    this.noFieldSelectedError = false;
    this.detailRequiredError = false;
    this.cdr.markForCheck();
  }

  close() {
    this.closed.emit();
  }

  submit() {
    this.noFieldSelectedError = this.selectedFields.size === 0;
    this.detailRequiredError = this.selectedFields.has('other') && !this.detail.trim();
    if (this.noFieldSelectedError || this.detailRequiredError) return;

    this.isSubmitting = true;
    this.errorMsg = '';
    this.alreadyReported = false;

    const payloadSuggested: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.suggested)) {
      if (this.selectedFields.has(k) && typeof v === 'string' && v.trim()) {
        payloadSuggested[k] = v.trim();
      }
    }

    this.bookService
      .reportBook({
        book: this.bookId,
        fields: Array.from(this.selectedFields),
        detail: this.detail.trim(),
        suggested: Object.keys(payloadSuggested).length ? payloadSuggested : undefined,
      })
      .subscribe({
        next: () => {
          this.isSubmitting = false;
          this.toast.success(this.i18n.t('bookReport.submittedToast'));
          this.submitted.emit();
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isSubmitting = false;
          const code = err?.error?.error?.code;
          if (code === 'moderation.errAlreadyReported') {
            this.alreadyReported = true;
          } else if (code === 'acct.errUnverifiedInRegion') {
            this.errorMsg = this.i18n.t('acct.errUnverifiedInRegion', err?.error?.error?.extra || {});
          } else {
            this.errorMsg = this.i18n.t('moderation.errGeneric');
          }
          this.cdr.markForCheck();
        },
      });
  }
}
