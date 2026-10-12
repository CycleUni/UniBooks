import { Component, Input, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

export interface RadioOption {
  value: string | number | boolean;
  label: string;
}

let nextId = 0;

@Component({
  selector: 'ui-radio-group',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="radio-group" role="radiogroup">
      <label *ngFor="let opt of options; let i = index" class="radio-label">
        <input
          type="radio"
          [name]="groupName"
          [value]="opt.value"
          [disabled]="disabled"
          [checked]="value === opt.value"
          (change)="onSelectionChange(opt.value)"
        />
        <span>{{ opt.label }}</span>
      </label>
    </div>
  `,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => UiRadioGroup),
      multi: true
    }
  ],
  styles: [`
    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 8px; /* Used in report-modal and search */
    }
    .radio-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: var(--text-base);
      color: var(--ink);
      cursor: pointer;
    }
    input[type="radio"] {
      appearance: none;
      -webkit-appearance: none;
      margin: 0;
      width: 18px;
      height: 18px;
      border: 1px solid var(--line-strong);
      border-radius: 50%;
      background-color: var(--paper);
      cursor: inherit;
      display: grid;
      place-content: center;
      flex-shrink: 0;
    }
    input[type="radio"]::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--btn-primary-ink);
      transform: scale(0);
      transition: transform var(--motion-fast) ease-in-out;
    }
    input[type="radio"]:checked {
      background-color: var(--accent);
      border-color: var(--accent);
    }
    input[type="radio"]:checked::before {
      transform: scale(1);
    }
    input[type="radio"]:disabled {
      background-color: var(--paper-warm);
      border-color: var(--line);
    }
    input[type="radio"]:disabled:checked {
      background-color: var(--muted);
      border-color: var(--muted);
    }
    .radio-label input:disabled,
    .radio-label input:disabled + span {
      cursor: not-allowed;
      color: var(--muted);
    }
  `]
})
export class UiRadioGroup implements ControlValueAccessor {
  @Input() options: RadioOption[] = [];
  @Input() disabled: boolean = false;

  value: any = null;
  groupName = `ui-radio-group-${nextId++}`;

  onChange = (val: any) => {};
  onTouched = () => {};

  onSelectionChange(val: any) {
    if (this.disabled) return;
    this.value = val;
    this.onChange(val);
    this.onTouched();
  }

  writeValue(val: any): void {
    this.value = val;
  }
  registerOnChange(fn: any): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }
  setDisabledState?(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }
}
