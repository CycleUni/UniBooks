import { Component, Input, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';

/**
 * Small check badge shown next to a verified seller/buyer's name.
 * Uses design tokens only (--success, --on-success) and has an accessible label.
 */
@Component({
  selector: 'ui-verified-badge',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <span
      class="verified-badge"
      [attr.aria-label]="'acct.verifiedBadge' | t"
      [attr.title]="'acct.verifiedBadge' | t"
      role="img"
    >
      <svg
        [attr.width]="size"
        [attr.height]="size"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7.5" fill="var(--success)" />
        <path
          d="M4.5 8.2 L7 10.7 L11.5 5.5"
          stroke="var(--on-success)"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="sr-only">{{ 'acct.verifiedBadge' | t }}</span>
    </span>
  `,
  styles: [`
    :host {
      display: inline-flex;
      vertical-align: middle;
      line-height: 1;
    }
    .verified-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: var(--space-1, 4px);
      vertical-align: middle;
    }
    svg {
      display: block;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `],
})
export class UiVerifiedBadge {
  private cdr = inject(ChangeDetectorRef);
  private _size = 15;

  @Input()
  set size(val: number) {
    this._size = val;
    this.cdr.markForCheck();
  }
  get size(): number {
    return this._size;
  }
}
