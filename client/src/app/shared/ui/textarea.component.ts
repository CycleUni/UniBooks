import { Component, Input, forwardRef, ChangeDetectorRef, inject } from '@angular/core';
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
        [attr.maxlength]="maxlength || null"
        [class.monospace]="monospace"
        (input)="onInputChange($event)"
        (blur)="onTouched()"
      ></textarea>
      <div class="textarea-footer" *ngIf="error || (showCounter && maxlength)">
        <span class="error" *ngIf="error">{{ error }}</span>
        <span class="counter" *ngIf="showCounter && maxlength">{{ (value || '').length }} / {{ maxlength }}</span>
      </div>
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
    .textarea-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-2);
    }
    .counter {
      margin-left: auto;
      font-size: var(--text-xs);
      color: var(--muted, #666);
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
  @Input() maxlength: number | null = null;
  @Input() showCounter: boolean = false;

  value: string = '';

  onChange = (val: string) => {};
  onTouched = () => {};

  onInputChange(event: Event) {
    const val = (event.target as HTMLTextAreaElement).value;
    this.value = val;
    this.onChange(val);
  }

  // Forms write through writeValue()/setDisabledState(), not through an input,
  // so an OnPush view would keep showing the old value (a chat box that stays
  // full after sending): mark it for check.
  private readonly cdr = inject(ChangeDetectorRef);

  writeValue(val: any): void {
    this.value = (val !== null && val !== undefined) ? String(val) : '';
    this.cdr.markForCheck();
  }
  registerOnChange(fn: any): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }
  setDisabledState?(isDisabled: boolean): void {
    this.disabled = isDisabled;
    this.cdr.markForCheck();
  }
}
