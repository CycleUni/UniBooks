import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  forwardRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TPipe } from '../../core/i18n.service';

/**
 * Shared pill-shaped search field for mobile viewports, used identically on
 * the home page compact header and the search page header.
 */
@Component({
  selector: 'ui-search-field',
  standalone: true,
  imports: [CommonModule, TPipe],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => UiSearchField),
      multi: true
    }
  ],
  template: `
    <form role="search" class="search-field-pill" (submit)="onSubmit($event)">
      <!-- The magnifier is the search button, as in most apps: a submit, so
           tapping it takes the same path as the keyboard's search key. -->
      <button type="submit" class="search-submit" [attr.aria-label]="'common.search' | t">
        <svg
          class="search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6.5"/>
          <line x1="20" y1="20" x2="15.4" y2="15.4"/>
        </svg>
      </button>

      <input
        #inputEl
        type="search"
        class="search-input"
        [value]="value"
        (input)="onInput($event)"
        (compositionstart)="onCompositionStart()"
        (compositionend)="onCompositionEnd()"
        (keydown)="onKeyDown($event)"
        (blur)="onBlur()"
        [placeholder]="'common.searchPlaceholder' | t"
        [attr.aria-label]="'common.search' | t"
        enterkeyhint="search"
        inputmode="search"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
        spellcheck="false"
      />

      <button
        *ngIf="value"
        type="button"
        class="clear-button"
        [attr.aria-label]="'common.clear' | t"
        (mousedown)="$event.preventDefault()"
        (click)="clear()"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>

      <button
        *ngIf="showScan"
        type="button"
        class="scan-button"
        [attr.aria-label]="'search.scanBarcode' | t"
        (click)="scan.emit()"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="20"
          height="20"
          aria-hidden="true"
        >
          <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/>
          <path d="M8 8v8M11 8v8M14 8v8M17 8v8"/>
        </svg>
      </button>
    </form>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }

    .search-field-pill {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 0 var(--space-3) 0 var(--space-4);
      min-height: 48px;
      background: var(--paper-warm);
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      box-sizing: border-box;
      transition: background-color var(--motion-base), border-color var(--motion-base);
    }

    .search-field-pill:focus-within {
      background: var(--surface-card);
      border-color: var(--accent);
    }

    /* A 32px target around the 18px icon, pulled left by the difference so
       the icon stays where it sat when it was only decoration. */
    .search-submit {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      margin-left: -7px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: none;
      color: var(--muted);
      cursor: pointer;
      transition: color var(--motion-base);
    }
    .search-submit:hover,
    .search-submit:focus-visible {
      color: var(--accent);
    }

    .search-input {
      flex: 1;
      min-width: 0;
      min-height: 46px;
      border: none;
      background: transparent;
      outline: none;
      padding: 0;
      margin: 0;
      font-family: inherit;
      /* >= 16px to prevent iOS Safari auto-zoom on input focus */
      font-size: var(--text-md);
      color: var(--ink);
    }

    .search-input::placeholder {
      color: var(--ink-soft);
      opacity: 1;
    }

    /* Hide native WebKit search cancel decorations since we provide a custom clear button */
    .search-input::-webkit-search-decoration,
    .search-input::-webkit-search-cancel-button,
    .search-input::-webkit-search-results-button,
    .search-input::-webkit-search-results-decoration {
      -webkit-appearance: none;
      display: none;
    }

    .clear-button {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: none;
      color: var(--muted);
      cursor: pointer;
      transition: color var(--motion-base);
    }

    .clear-button:hover,
    .clear-button:focus-visible {
      color: var(--ink);
    }

    .scan-button {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: none;
      color: var(--ink);
      cursor: pointer;
      transition: color var(--motion-base);
    }

    .scan-button:hover,
    .scan-button:focus-visible {
      color: var(--accent);
    }
  `]
})
export class UiSearchField implements ControlValueAccessor {
  @ViewChild('inputEl') private inputElement?: ElementRef<HTMLInputElement>;

  @Input() showScan = false;
  @Output() search = new EventEmitter<string>();
  @Output() scan = new EventEmitter<void>();

  private _value = '';

  @Input()
  set value(val: string) {
    this._value = val ?? '';
  }
  get value(): string {
    return this._value;
  }
  @Output() valueChange = new EventEmitter<string>();

  isComposing = false;
  private justEndedComposition = false;

  onChange = (_val: string) => {};
  onTouched = () => {};

  writeValue(val: any): void {
    this._value = (val !== null && val !== undefined) ? String(val) : '';
  }

  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  onInput(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this._value = val;
    this.onChange(val);
    this.valueChange.emit(val);
  }

  onBlur(): void {
    this.onTouched();
  }

  onCompositionStart(): void {
    this.isComposing = true;
  }

  onCompositionEnd(): void {
    this.isComposing = false;
    this.justEndedComposition = true;
    setTimeout(() => {
      this.justEndedComposition = false;
    });
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      // Do not submit while confirming IME candidate words
      if (this.isComposing || this.justEndedComposition || event.isComposing) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      this.submit();
    }
  }

  onSubmit(event?: Event): void {
    event?.preventDefault();
    if (this.isComposing || this.justEndedComposition) {
      return;
    }
    this.submit();
  }

  private submit(): void {
    if (this.isComposing || this.justEndedComposition) {
      return;
    }
    const q = this.value.trim();
    if (!q) {
      // Nothing to search for: a tap on the magnifier means "let me type".
      this.focus();
      return;
    }
    this.blur();
    this.search.emit(q);
  }

  clear(): void {
    this._value = '';
    this.onChange('');
    this.valueChange.emit('');
    this.focus();
  }

  focus(): void {
    this.inputElement?.nativeElement.focus();
  }

  blur(): void {
    this.inputElement?.nativeElement.blur();
  }
}
