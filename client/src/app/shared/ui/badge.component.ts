import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'ui-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span [class]="'badge ' + (condition ? 'cond-' + condition : type)">
      <ng-content></ng-content>
    </span>
  `,
  styles: [`
    .badge {
      display: inline-block;
      padding: 2px 6px;
      font-size: var(--text-xs);
      border-radius: 2px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      white-space: nowrap;
    }
    .cond-new, .cond-like_new {
      border-color: var(--accent);
      color: var(--accent);
    }
    .cond-noted, .cond-damaged {
      border-color: var(--flag);
      color: var(--flag);
    }
    .waitlist {
      border-color: var(--flag);
      color: var(--flag);
    }
  `]
})
export class UiBadge {
  @Input() condition?: 'new' | 'like_new' | 'noted' | 'damaged';
  @Input() type?: 'waitlist' | 'default' = 'default';
}
