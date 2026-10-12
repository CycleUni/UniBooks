import { Component, Input, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'ui-textarea',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="input-wrapper" [class.no-margin]="noMargin">
      <label *ngIf="label">{{ label }}</label>
      <textarea
        [placeholder]="placeholder"
        [rows]="rows"
        [value]="value"
        [disabled]="disabled"
        [class.monospace]="monospace"
        (input)="onInputChange($event)"
        (blur)="onTouched()"
      ></textarea>
      <span class="error" *ngIf="error">{{ error }}</span>
    </div>
  `,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => UiTextarea),
      multi: true
    }
  ],
  styles: [`
    :host {
      display: block;
    }
    .input-wrapper {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      margin-bottom: var(--space-3);
    }
    .input-wrapper.no-margin {
      margin-bottom: 0;
    }
    label {
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--ink);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-control);
      font-size: var(--text-base);
      font-family: inherit;
      color: var(--ink);
      background-color: var(--paper);
      resize: vertical;
    }
    textarea.monospace {
      font-family: monospace;
    }
    @media (pointer: coarse) {
      textarea {
        font-size: var(--text-md);
      }
    }
    textarea:focus-visible {
      border-bottom-color: var(--accent);
      outline: 2px solid transparent;
    }
    textarea:disabled {
      background-color: var(--paper-warm);
      cursor: not-allowed;
    }
    .error {
      color: var(--danger);
      font-size: var(--text-xs);
    }
  `]
})
export class UiTextarea implements ControlValueAccessor {
  @Input() label: string = '';
  @Input() placeholder: string = '';
  @Input() rows: number = 3;
  @Input() error: string = '';
  @Input() noMargin: boolean = false;
  @Input() monospace: boolean = false;
  @Input() disabled: boolean = false;

  value: string = '';

  onChange = (val: string) => {};
  onTouched = () => {};

  onInputChange(event: Event) {
    const val = (event.target as HTMLTextAreaElement).value;
    this.value = val;
    this.onChange(val);
  }

  writeValue(val: any): void {
    this.value = (val !== null && val !== undefined) ? String(val) : '';
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
