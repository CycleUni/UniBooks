import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';
import { UiButton } from './button.component';
import { UiSuccessCheck } from './success-check.component';

export type MeetupMessageType = 'REQUEST' | 'ACCEPT' | 'UPDATE' | 'DECLINE' | 'CANCEL' | 'COMPLETE' | 'NONE';

const CIRCLE = 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z';
/** Line icons in place of emoji, which render differently on every platform. */
const MEETUP_ICONS: Record<string, readonly string[]> = {
  // calendar
  REQUEST: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  // map pin
  UPDATE: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z', 'M12 7a3 3 0 1 0 0 6a3 3 0 1 0 0-6z'],
  // circled x
  DECLINE: [CIRCLE, 'm15 9-6 6', 'm9 9 6 6'],
  // ban
  CANCEL: [CIRCLE, 'm4.9 4.9 14.2 14.2'],
  // package
  COMPLETE: [
    'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
    'M3.27 6.96 12 12.01l8.73-5.05',
    'M12 22.08V12',
  ],
};

@Component({
  selector: 'ui-meetup-card',
  standalone: true,
  imports: [CommonModule, TPipe, UiButton, UiSuccessCheck],
  template: `
    <div class="meetup-card" [ngClass]="typeClass">
      <div class="meetup-card-header">
        <span class="meetup-icon">
          <ui-success-check *ngIf="cardType === 'ACCEPT'; else glyph" [size]="20"></ui-success-check>
          <ng-template #glyph>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path *ngFor="let d of iconPaths" [attr.d]="d" />
            </svg>
          </ng-template>
        </span>
        <span class="meetup-title">{{ headerTitleKey | t }}</span>
        <span class="meetup-status-badge" *ngIf="statusBadgeKey">{{ statusBadgeKey | t }}</span>
      </div>
      
      <p class="meetup-card-body">{{ bodyTextKey | t }}</p>

      <!-- The agreed time/place, on the one card that shows the current
           details (Messages.showsMeetupDetails). -->
      <dl class="meetup-details" *ngIf="showDetails">
        <div class="meetup-detail-row">
          <dt>{{ 'msg.meetupTimeLabel' | t }}</dt>
          <dd [class.unset]="!meetupTime">{{ meetupTime ? (meetupTime | date:'yyyy/MM/dd HH:mm') : ('msg.meetupNotSet' | t) }}</dd>
        </div>
        <div class="meetup-detail-row">
          <dt>{{ 'msg.meetupLocationLabel' | t }}</dt>
          <dd [class.unset]="!meetupLocation">{{ meetupLocation || ('msg.meetupNotSet' | t) }}</dd>
        </div>
      </dl>

      <div class="meetup-card-actions" *ngIf="canEdit">
        <ui-button size="sm" variant="ghost" [disabled]="busy" (onClick)="onEdit.emit()">
          {{ 'msg.meetupActionEdit' | t }}
        </ui-button>
      </div>

      <div class="meetup-card-actions" *ngIf="showActions">
        <!-- Seller Actions (Current User is Seller: userRole is 'seller') -->
        <ng-container *ngIf="userRole === 'seller'">
          <ui-button size="sm" [disabled]="busy" (onClick)="onAccept.emit()">
            {{ 'msg.meetupActionAccept' | t }}
          </ui-button>
          <ui-button size="sm" variant="ghost" [disabled]="busy" (onClick)="onDecline.emit()">
            {{ 'msg.meetupActionDecline' | t }}
          </ui-button>
        </ng-container>

        <!-- Buyer Actions (Current User is Buyer: userRole is 'buyer') -->
        <ng-container *ngIf="userRole === 'buyer'">
          <ui-button size="sm" variant="ghost" [disabled]="busy" (onClick)="onCancel.emit()">
            {{ 'msg.meetupActionCancel' | t }}
          </ui-button>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      max-width: 360px;
    }
    .meetup-card {
      border-radius: var(--radius-panel);
      padding: 14px 16px;
      box-shadow: var(--shadow-card);
      /* Enumerated, not 'all': the card's height changes when the status line
         wraps, and 'all' animated that as a resize. */
      transition: background-color var(--motion-base) ease, border-color var(--motion-base) ease;
      border: 1px solid var(--line);
    }
    
    /* Request Card Variant (Accent Teal) */
    .meetup-card.card-request {
      background-color: var(--paper-warm);
      border-left: 4px solid var(--accent);
    }
    .meetup-card.card-request .meetup-title {
      color: var(--accent);
    }

    /* Accept Card Variant (Green Success) */
    .meetup-card.card-accept, .meetup-card.card-complete {
      background-color: var(--success-light);
      border: 1px solid var(--line);
      border-left: 4px solid var(--success);
    }
    .meetup-card.card-accept .meetup-title, .meetup-card.card-complete .meetup-title {
      color: var(--success);
    }

    /* Decline Card Variant (Red Error) */
    .meetup-card.card-decline {
      background-color: var(--danger-light);
      border: 1px solid var(--line);
      border-left: 4px solid var(--danger);
    }
    .meetup-card.card-decline .meetup-title {
      color: var(--danger);
    }

    /* Cancel Card Variant (Muted Gray) */
    .meetup-card.card-cancel {
      background-color: var(--paper-warm);
      border: 1px solid var(--line);
      border-left: 4px solid var(--muted);
    }
    .meetup-card.card-cancel .meetup-title {
      color: var(--muted);
    }

    .meetup-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .meetup-icon {
      display: inline-flex;
      flex-shrink: 0;
      color: var(--accent);
    }
    .card-decline .meetup-icon {
      color: var(--danger);
    }
    .card-cancel .meetup-icon {
      color: var(--muted);
    }
    .meetup-title {
      font-weight: 700;
      font-size: var(--text-base);
      flex: 1;
    }
    .meetup-status-badge {
      font-size: var(--text-xs);
      padding: 2px 8px;
      border-radius: 12px;
      /* A wash of the ink colour rather than black: the badge sits on each
         status tint, and a black wash vanishes on the dark palette. */
      background: color-mix(in srgb, var(--ink) 8%, transparent);
      color: var(--ink);
      font-weight: 500;
    }
    .meetup-card-body {
      font-size: var(--text-sm);
      color: var(--ink);
      margin: 0;
      line-height: 1.5;
    }
    .meetup-details {
      margin: 10px 0 0;
      padding: 10px 12px;
      border-radius: var(--radius-panel);
      background: var(--paper);
      border: 1px solid var(--line);
      display: grid;
      gap: 4px;
    }
    .meetup-detail-row {
      display: flex;
      gap: 12px;
      font-size: var(--text-sm);
      line-height: 1.5;
    }
    .meetup-detail-row dt {
      flex: none;
      color: var(--muted);
      min-width: 3em;
    }
    .meetup-detail-row dd {
      margin: 0;
      color: var(--ink);
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meetup-detail-row dd.unset {
      color: var(--muted);
      font-weight: 400;
    }
    .meetup-card-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px dashed var(--line);
    }
  `]
})
export class UiMeetupCard {
  @Input() body = '';
  @Input() userRole: 'buyer' | 'seller' = 'buyer'; // current user's role in transaction
  @Input() isPendingApproval = false; // whether order status is 'awaiting_approval'

  /** The agreed meetup, shown when `showDetails` is set. */
  @Input() meetupTime: string | null = null;
  @Input() meetupLocation = '';
  @Input() showDetails = false;
  /** Offers the seller an edit of the details shown. */
  @Input() canEdit = false;
  /** An action from this card is on its way: its buttons wait for it. */
  @Input() busy = false;

  @Output() onAccept = new EventEmitter<void>();
  @Output() onEdit = new EventEmitter<void>();
  @Output() onDecline = new EventEmitter<void>();
  @Output() onCancel = new EventEmitter<void>();

  get cardType(): MeetupMessageType {
    if (!this.body) return 'NONE';
    if (this.body.includes('[SYSTEM:order.notify.meetup_requested]')) return 'REQUEST';
    if (this.body.includes('[SYSTEM:order.notify.seller_approved]') || this.body.includes('[SYSTEM:order.notify.meetup_accepted]')) return 'ACCEPT';
    if (this.body.includes('[SYSTEM:order.notify.seller_rejected]') || this.body.includes('[SYSTEM:order.notify.meetup_declined]')) return 'DECLINE';
    if (
      this.body.includes('[SYSTEM:order.notify.cancelled_by_buyer]') ||
      this.body.includes('[SYSTEM:order.notify.cancelled_by_seller]') ||
      this.body.includes('[SYSTEM:order.notify.meetup_cancelled]')
    ) return 'CANCEL';
    if (this.body.includes('[SYSTEM:order.notify.delivered]')) return 'COMPLETE';
    if (this.body.includes('[SYSTEM:order.notify.meetup_updated]')) return 'UPDATE';
    return 'NONE';
  }

  get typeClass(): string {
    switch (this.cardType) {
      case 'REQUEST': return 'card-request';
      case 'ACCEPT': return 'card-accept';
      case 'UPDATE': return 'card-accept';
      case 'DECLINE': return 'card-decline';
      case 'CANCEL': return 'card-cancel';
      case 'COMPLETE': return 'card-complete';
      default: return 'card-request';
    }
  }

  /** Outline icon paths (24px grid) per card; ACCEPT draws <ui-success-check> instead. */
  get iconPaths(): readonly string[] {
    return MEETUP_ICONS[this.cardType] ?? MEETUP_ICONS['REQUEST'];
  }

  get headerTitleKey(): string {
    switch (this.cardType) {
      case 'REQUEST': return 'msg.meetupRequestTitle';
      case 'ACCEPT': return 'msg.meetupAcceptTitle';
      case 'UPDATE': return 'msg.meetupUpdateTitle';
      case 'DECLINE': return 'msg.meetupDeclineTitle';
      case 'CANCEL': return 'msg.meetupCancelTitle';
      case 'COMPLETE': return 'msg.meetupCompleteTitle';
      default: return 'msg.meetupRequestTitle';
    }
  }

  get bodyTextKey(): string {
    switch (this.cardType) {
      case 'REQUEST': return 'msg.meetupRequestBody';
      case 'ACCEPT': return this.showDetails ? 'msg.meetupAcceptBodyDetails' : 'msg.meetupAcceptBody';
      case 'UPDATE': return 'msg.meetupUpdateBody';
      case 'DECLINE': return 'msg.meetupDeclineBody';
      case 'CANCEL': return 'msg.meetupCancelBody';
      case 'COMPLETE': return 'msg.meetupCompleteBody';
      default: return 'msg.meetupRequestBody';
    }
  }

  get statusBadgeKey(): string | null {
    if (this.cardType === 'ACCEPT') return 'msg.statusAccepted';
    if (this.cardType === 'DECLINE') return 'msg.statusDeclined';
    if (this.cardType === 'CANCEL') return 'msg.statusCancelled';
    if (this.cardType === 'COMPLETE') return 'msg.statusCompleted';
    if (this.cardType === 'REQUEST') {
      return this.isPendingApproval ? 'msg.statusPendingApproval' : 'msg.statusProcessed';
    }
    return null;
  }

  get showActions(): boolean {
    return this.cardType === 'REQUEST' && this.isPendingApproval;
  }
}
