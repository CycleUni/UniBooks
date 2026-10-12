import { Component, Input, Output, EventEmitter, inject, HostBinding } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiButton } from './button.component';
import { I18nService } from '../../core/i18n.service';

@Component({
  selector: 'ui-empty',
  standalone: true,
  imports: [CommonModule, UiButton],
  template: `
    <div class="empty-state" [class.full-page]="fullPage">
      <ng-content></ng-content>
      <ng-container *ngIf="message">
        <h3 class="message">{{ message }}</h3>
        <p class="description" *ngIf="description">{{ description }}</p>
        <div class="action" *ngIf="actionText">
          <ui-button (onClick)="onAction.emit($event)">{{ actionText }}</ui-button>
        </div>
      </ng-container>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
    :host(.full-page) {
      flex: 1;
      display: flex;
    }
    /* Layout only. The border/background/padding/colour deliberately are NOT
       redeclared here: the global .empty-state in styles.css owns those, and
       this component used to ship its own weaker copy (--line at 1.48:1, plus
       a radius the global one does not have). Emulated encapsulation gives a
       component rule the higher specificity, so <ui-empty> — the majority of
       the empty states in the app — could never pick the shared look up. */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 100%;
    }
    .empty-state.full-page {
      flex: 1;
      border: none;
      background-color: transparent;
      /* Keeps the narrower side padding the component always had here. The
         global .empty-state's var(--space-7) is sized for a boxed card inside
         a gutter'd page; a full-page state fills a whole column on its own, so
         48px of side padding eats a phone-width layout. */
      padding: var(--space-7) var(--space-4);
    }
    .message {
      margin: 0 0 8px;
      font-size: var(--text-lg);
      color: var(--ink);
    }
    .description {
      margin: 0 0 16px;
      font-size: var(--text-base);
      color: var(--muted);
    }
  `]
})
export class UiEmpty {
  private i18n = inject(I18nService);

  @Input() message?: string;
  @Input() description?: string;
  @Input() actionText?: string;
  @Input() @HostBinding('class.full-page') fullPage = false;
  @Output() onAction = new EventEmitter<Event>();
}
