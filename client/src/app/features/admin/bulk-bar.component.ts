import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TPipe } from '../../core/i18n.service';
import { UiButton } from '../../shared/ui/button.component';

/**
 * The bar above an admin table that acts on its ticked rows. The list puts
 * its action buttons inside; the bar adds the count and "clear selection".
 * Shown whenever the table has rows that can be ticked, not only once one
 * is, so ticking the first row does not push the table down under the
 * pointer.
 */
@Component({
  selector: 'admin-bulk-bar',
  standalone: true,
  imports: [TPipe, UiButton],
  template: `
    <div class="bulk-bar">
      <span class="count" aria-live="polite">{{
        count ? ('admin.bulk.selected' | t: { n: count }) : ('admin.bulk.hint' | t)
      }}</span>
      <ng-content></ng-content>
      <ui-button size="sm" variant="ghost" [disabled]="busy || !count" (onClick)="clear.emit()">{{
        'admin.bulk.clear' | t
      }}</ui-button>
    </div>
  `,
  styles: [
    `
      .bulk-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        padding: 8px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface-card);
        font-size: var(--text-sm);
        color: var(--ink-soft);
      }
      .count {
        margin-right: auto;
      }
    `,
  ],
})
export class AdminBulkBarComponent {
  @Input() count = 0;
  /** A bulk action is running: nothing else may start. */
  @Input() busy = false;
  @Output() clear = new EventEmitter<void>();
}
