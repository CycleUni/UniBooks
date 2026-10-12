import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface ConditionOption {
  label: string;
  value: string;
}

/**
 * `condition-picker`: a row of text "chips" for choosing a book condition —
 * a lighter "editorial" alternative to a boxed `ui-dropdown`. Each chip is a
 * bordered box with a small dot indicator; the selected chip gets an accent
 * border, bold label, and filled dot (same visual language as
 * `ui-facet-list`'s dot, for consistency).
 *
 * Simple two-way binding via `value`/`valueChange` — no ControlValueAccessor,
 * to keep this in line with how `sell.html` binds `condition` today.
 */
@Component({
  selector: 'ui-condition-picker',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="condition-picker">
      <label class="picker-label" *ngIf="label">{{ label }}</label>
      <div class="chip-row">
        <button
          type="button"
          class="chip"
          *ngFor="let option of options"
          [class.selected]="option.value === value"
          (click)="select(option.value)"
        >
          <span class="chip-dot"></span>
          <span class="chip-label">{{ option.label }}</span>
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
    .condition-picker {
      margin-bottom: 12px;
    }
    .picker-label {
      display: block;
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--ink);
      margin-bottom: 8px;
    }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border: 1px solid var(--line);
      border-radius: var(--radius-xs);
      background: var(--paper);
      color: var(--ink);
      font-size: var(--text-base);
      font-family: inherit;
      cursor: pointer;
      transition: border-color var(--motion-fast);
    }
    .chip:hover {
      border-color: var(--accent);
    }
    .chip.selected {
      border-color: var(--accent);
      font-weight: 700;
    }
    .chip-dot {
      flex-shrink: 0;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1.5px solid var(--line);
      box-sizing: border-box;
    }
    .chip.selected .chip-dot {
      background: var(--accent);
      border-color: var(--accent);
    }
  `]
})
export class UiConditionPicker {
  @Input() label: string = '';
  @Input() options: ConditionOption[] = [];
  @Input() value: string = '';
  @Output() valueChange = new EventEmitter<string>();

  select(value: string) {
    if (value === this.value) return;
    this.value = value;
    this.valueChange.emit(value);
  }
}
