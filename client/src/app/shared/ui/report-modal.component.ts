import { ChangeDetectorRef, Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { I18nService, TPipe } from '../../core/i18n.service';
import { translateApiError } from '../../core/api-error.util';
import { UiButton } from './button.component';
import { UiRadioGroup } from './radio-group.component';
import { UiTextarea } from './textarea.component';
import { UiFocusTrapDirective } from './focus-trap.directive';

/**
 * "Report this conversation" dialog.
 *
 * Owns the whole interaction — reason list, draft state, the POST, and its
 * success/error feedback — rather than being a dumb shell driven by the host.
 * The host only says which conversation is being reported and reacts to
 * `close`; nothing about reporting leaks back into the Messages page.
 *
 * Extracted from the Messages page, which had grown past the
 * `anyComponentStyle` build budget — see also UiImageLightbox and
 * MessagesInboxList.
 */
@Component({
  selector: 'ui-report-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiRadioGroup, UiTextarea, TPipe, UiFocusTrapDirective],
  template: `
    <div class="report-overlay" (click)="close.emit()">
      <div class="report-modal" (click)="$event.stopPropagation()" uiFocusTrap="report-modal-title" (escape)="close.emit()">
        <h4 id="report-modal-title">{{ 'msg.reportTitle' | t }}</h4>
        <div class="report-reasons">
          <ui-radio-group [options]="reasons" [(ngModel)]="reason"></ui-radio-group>
        </div>
        <ui-textarea [(ngModel)]="detail" [placeholder]="'msg.reportDetail' | t"></ui-textarea>
        <div class="report-actions">
          <ui-button variant="ghost" (onClick)="close.emit()">{{ 'msg.reportCancel' | t }}</ui-button>
          <ui-button [disabled]="!reason || submitting" (onClick)="submit()">
            {{ submitting ? ('msg.reportSubmitting' | t) : ('msg.reportSubmit' | t) }}
          </ui-button>
        </div>
        <div *ngIf="error" class="error-msg">{{ error }}</div>
        <div *ngIf="success" class="success-msg">{{ success }}</div>
      </div>
    </div>
  `,
  styles: [`
    .report-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .report-modal { background: var(--surface-raised); border: 1px solid var(--surface-raised-border); border-radius: 12px; padding: 24px; max-width: 400px; width: 90%; max-height: 90vh; overflow-y: auto; }
    .report-modal h4 { margin-top: 0; margin-bottom: 16px; }
    .report-reasons { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    .report-reason { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: var(--text-base); }
    .report-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .error-msg { color: var(--danger); font-size: var(--text-sm); margin-top: 8px; }
    .success-msg { color: var(--accent); font-size: var(--text-sm); margin-top: 8px; }
  `]
})
export class UiReportModal implements OnInit {
  @Input() conversationId!: string;
  /** The other party in the conversation — the user being reported. */
  @Input() reportedPartyId!: string | number;
  @Output() close = new EventEmitter<void>();

  reasons: { value: string; label: string }[] = [];
  reason = '';
  detail = '';
  error = '';
  success = '';
  submitting = false;

  private http = inject(HttpClient);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  ngOnInit() {
    this.reasons = [
      { value: 'harassment', label: this.i18n.t('msg.reportReasonHarassment') },
      { value: 'scam', label: this.i18n.t('msg.reportReasonScam') },
      { value: 'spam', label: this.i18n.t('msg.reportReasonSpam') },
      { value: 'other', label: this.i18n.t('msg.reportReasonOther') },
    ];
  }

  submit() {
    if (!this.conversationId || this.submitting) return;
    this.submitting = true;
    this.error = '';

    this.http.post('/moderation/chat-reports/', {
      conversation: this.conversationId,
      reported_party: this.reportedPartyId,
      reason: this.reason,
      detail: this.detail || '',
    }).subscribe({
      next: () => {
        this.success = this.i18n.t('msg.reportSuccess');
        this.submitting = false;
        // Leave the confirmation up briefly so it's actually readable before
        // the dialog disappears.
        setTimeout(() => this.close.emit(), 2000);
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        // A serializer raise answers {"reported_party": ["<code>"]}, not the
        // {"error": {"code"}} contract this used to read — so the check that
        // the reported party is really the other participant landed here as
        // the generic "could not report" message.
        this.error = translateApiError(err, this.i18n)
          ?? err?.error?.error?.detail
          ?? this.i18n.t('msg.reportError');
        this.submitting = false;
        this.cdr.markForCheck();
      },
    });
  }
}
