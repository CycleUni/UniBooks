import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, Input, Output, EventEmitter, booleanAttribute } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'ui-button',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule],
  host: {
    '[class.is-block]': 'block'
  },
  template: `
    <a
      *ngIf="link"
      [class]="'ui-btn ' + variant + ' ' + size + (hostClass ? ' ' + hostClass : '')"
      [regionLink]="link"
      [queryParams]="linkParams"
      (click)="onClick.emit($event)"
    >
      <ng-container *ngTemplateOutlet="content"></ng-container>
    </a>
    <button
      *ngIf="!link"
      [class]="'ui-btn ' + variant + ' ' + size + (hostClass ? ' ' + hostClass : '')"
      [disabled]="disabled"
      [attr.type]="type"
      (click)="onClick.emit($event)"
    >
      <ng-container *ngTemplateOutlet="content"></ng-container>
    </button>

    <!-- Projected once, rendered into whichever branch is live. Putting an
         <ng-content> inside each branch instead does NOT work: a component
         has a single projection slot per selector, so the content lands in
         the last declared <ng-content> and the other branch renders empty. -->
    <ng-template #content><ng-content></ng-content></ng-template>
  `,
  styles: [`
    :host {
      display: inline-block;
      align-self: stretch;
    }
    :host.is-block {
      display: block;
      width: 100%;
    }
    .ui-btn {
      width: 100%;
      text-decoration: none;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      min-height: 40px;
      font-size: var(--text-base);
      font-weight: 500;
      font-family: inherit;
      line-height: 1.2;
      border-radius: var(--radius-control);
      cursor: pointer;
      transition: background-color var(--motion-base), color var(--motion-base), border-color var(--motion-base);
      border: 1px solid transparent;
    }
    /* Touch devices get the full 44pt/48dp target; pointer devices keep the
       denser 40px box so admin tables and toolbars don't balloon. Sizing on
       pointer type rather than viewport width is what actually tracks the
       thing being compensated for — finger vs cursor. */
    @media (pointer: coarse) {
      .ui-btn { min-height: var(--tap-min); }
    }
    /* Hero and other primary page-level calls to action. The default size is
       tuned for toolbars; at 14px/38px a hero CTA sitting under a 52px serif
       title read as the weakest element on the page. */
    .ui-btn.lg {
      min-height: 48px;
      padding: var(--space-3) var(--space-6);
      font-size: var(--text-lg);
      border-radius: var(--radius-control);
    }
    .ui-btn.sm {
      min-height: 32px;
      padding: var(--space-1) var(--space-3);
      font-size: var(--text-sm);
    }
    @media (pointer: coarse) {
      .ui-btn.sm { min-height: 36px; }
    }
    .ui-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    /* Blocked, not disabled: the button must stay clickable so pressing it can
       explain why the action is blocked. Dimming is the only signal;
       \`disabled\` or \`pointer-events: none\` would swallow the click. */
    .ui-btn.is-blocked {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .primary {
      background-color: var(--btn-primary-bg);
      color: var(--btn-primary-ink);
    }
    .primary:hover:not(:disabled) {
      background-color: var(--btn-primary-bg-hover);
    }
    .ghost {
      background-color: transparent;
      color: var(--ink);
      border-color: var(--line-strong);
    }
    .ghost:hover:not(:disabled) {
      background-color: var(--paper-warm);
      border-color: var(--ink);
    }
    /* "White" means "the page's own surface", not literal #fff — hardcoding
       white put a blinding panel-colored button on the dark palette. */
    .white {
      background-color: var(--paper);
      color: var(--ink);
      border-color: var(--line-strong);
    }
    .white:hover:not(:disabled) {
      background-color: var(--paper-warm);
    }
    .danger {
      background-color: transparent;
      color: var(--danger);
      border-color: var(--danger);
    }
    .danger:hover:not(:disabled) {
      background-color: var(--danger-light);
    }
    .outline {
      background-color: transparent;
      color: var(--accent);
      border-color: var(--accent);
    }
    .outline:hover:not(:disabled) {
      background-color: var(--paper-warm);
    }
    .secondary {
      background-color: var(--paper-warm);
      color: var(--ink);
      /* --line-strong, not --line: a button's edge is an interactive
         boundary, and --line is 1.48:1 — below WCAG 1.4.11's 3:1. */
      border-color: var(--line-strong);
    }
    .secondary:hover:not(:disabled) {
      background-color: var(--line);
    }
  `]
})
export class UiButton {
  /**
   * Render as a link instead of a button.
   *
   * Putting `routerLink` on `<ui-button>` from the outside looked equivalent
   * but was not: RouterLink gives the *host* element tabindex="0" while the
   * inner <button> keeps its own, so a single control consumed two tab stops
   * and screen readers announced it twice. Navigation belongs on a real
   * anchor, so the component renders one when a link is supplied.
   */
  @Input() link?: any[] | string;
  @Input() linkParams?: Record<string, any>;
  @Input() variant: 'primary' | 'ghost' | 'white' | 'danger' | 'outline' | 'secondary' = 'primary';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Input() type: string = 'button';
  @Input() disabled: boolean = false;
  @Input({ transform: booleanAttribute }) block: boolean = false;
  @Input() hostClass: string = '';
  @Output() onClick = new EventEmitter<Event>();
}
