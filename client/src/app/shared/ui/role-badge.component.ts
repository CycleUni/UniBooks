import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';

/**
 * "Buyer"/"Seller" pill shown next to a counterparty's name.
 *
 * Extracted because the Messages page styled `.role-badge` twice with
 * conflicting values — the later block silently won on every shared property,
 * leaving only `text-transform` from the earlier one actually in effect. The
 * merged rule below is what was really rendering.
 */
@Component({
  selector: 'ui-role-badge',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `<span class="role-badge" [class.seller]="role === 'seller'">{{ ('msg.role_' + role) | t }}</span>`,
  styles: [`
    :host { display: inline-flex; }
    .role-badge {
      font-size: var(--text-xs);
      font-weight: normal;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      white-space: nowrap;
      background: var(--flag);
      color: var(--on-flag);
    }
    .role-badge.seller { background: var(--accent); color: var(--on-accent); }
  `]
})
export class UiRoleBadge {
  /** 'buyer' | 'seller' — drives both the label and the colour. */
  @Input() role = '';
}
