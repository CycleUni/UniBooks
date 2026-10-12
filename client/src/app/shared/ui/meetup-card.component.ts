import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';
import { UiButton } from './button.component';

export type MeetupMessageType = 'REQUEST' | 'ACCEPT' | 'UPDATE' | 'DECLINE' | 'CANCEL' | 'COMPLETE' | 'NONE';

@Component({
  selector: 'ui-meetup-card',
  standalone: true,
  imports: [CommonModule, TPipe, UiButton],
  template: `
    <div class="meetup-card" [ngClass]="typeClass">
      <div class="meetup-card-header">
        <span class="meetup-icon">{{ icon }}</span>
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
        <ui-button size="sm" variant="ghost" (onClick)="onEdit.emit()">
          {{ 'msg.meetupActionEdit' | t }}
        </ui-button>
      </div>

      <div class="meetup-card-actions" *ngIf="showActions">
        <!-- Seller Actions (Current User is Seller: userRole is 'seller') -->
        <ng-container *ngIf="userRole === 'seller'">
          <ui-button size="sm" (onClick)="onAccept.emit()">
            {{ 'msg.meetupActionAccept' | t }}
          </ui-button>
          <ui-button size="sm" variant="ghost" (onClick)="onDecline.emit()">
            {{ 'msg.meetupActionDecline' | t }}
          </ui-button>
        </ng-container>

        <!-- Buyer Actions (Current User is Buyer: userRole is 'buyer') -->
        <ng-container *ngIf="userRole === 'buyer'">
          <ui-button size="sm" variant="ghost" (onClick)="onCancel.emit()">
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
      border-radius: 10px;
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
      font-size: var(--text-lg);
      line-height: 1;
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
      border-radius: 8px;
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

  @Output() onAccept = new EventEmitter<void>();
  @Output() onEdit = new EventEmitter<void>();
  @Output() onDecline = new EventEmitter<void>();
  @Output() onCancel = new EventEmitter<void>();

  get cardType(): MeetupMessageType {
    if (!this.body) return 'NONE';
    // Support both legacy [MEETUP_*] and new [SYSTEM:...] formats
    if (this.body.includes('[MEETUP_REQUEST]') || this.body.includes('[SYSTEM:order.notify.meetup_requested]')) return 'REQUEST';
    if (this.body.includes('[MEETUP_ACCEPT]') || this.body.includes('[SYSTEM:order.notify.seller_approved]') || this.body.includes('[SYSTEM:order.notify.meetup_accepted]')) return 'ACCEPT';
    if (this.body.includes('[MEETUP_DECLINE]') || this.body.includes('[SYSTEM:order.notify.seller_rejected]') || this.body.includes('[SYSTEM:order.notify.meetup_declined]')) return 'DECLINE';
    if (
      this.body.includes('[MEETUP_CANCEL]') ||
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

  get icon(): string {
    switch (this.cardType) {
      case 'REQUEST': return '🤝';
      case 'ACCEPT': return '✅';
      case 'UPDATE': return '📍';
      case 'DECLINE': return '❌';
      case 'CANCEL': return '🚫';
      case 'COMPLETE': return '📦';
      default: return '🤝';
    }
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
