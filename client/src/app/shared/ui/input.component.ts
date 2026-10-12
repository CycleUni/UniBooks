import { Component, Input, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CommonModule } from '@angular/common';

/** Per-instance ids for the inner <input>. A counter rather than anything
 *  random: the app is client-rendered only, and a counter keeps ids readable
 *  in the DOM and stable across change detection. */
let nextInputId = 0;

@Component({
  selector: 'ui-input',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="input-wrapper" [class.no-margin]="noMargin">
      <label *ngIf="label" [attr.for]="controlId">{{ label }}</label>
      <input
        [id]="controlId"
        [type]="type"
        [attr.name]="name || null"
        [attr.autocomplete]="autocomplete || null"
        [attr.inputmode]="inputmode || null"
        [attr.enterkeyhint]="enterkeyhint || null"
        [attr.aria-label]="ariaLabel || null"
        [attr.aria-describedby]="ariaDescribedby || null"
        [placeholder]="placeholder"
        [value]="value"
        [disabled]="disabled"
        (input)="onInputChange($event)"
        (blur)="onTouched()"
      />
      <span class="error" *ngIf="error">{{ error }}</span>
    </div>
  `,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => UiInput),
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
    input {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-2) var(--space-3);
      min-height: 40px;
      /* --line is the decorative hairline (1.5:1 on paper); a field the user
         is meant to click into is an interactive boundary and needs the 3:1
         weight, or the input reads as floating text with no affordance. */
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-control);
      font-size: var(--text-base);
      font-family: inherit;
      color: var(--ink);
      background-color: var(--paper);
    }
    /* Touch: full 44pt target, and >=16px text because iOS Safari auto-zooms
       the viewport on focus for anything smaller and never zooms back out. */
    @media (pointer: coarse) {
      input {
        min-height: var(--tap-min);
        font-size: var(--text-md);
      }
    }
    /* Focus recolours the underline to --accent and adds no thickness. The
       green line clears 3:1 against the field background on its own (7.85:1
       light, 5.36:1 dark), which is what WCAG 1.4.11 (AA) asks of a state
       indicator. The luminance delta between --ink and --accent is only
       1.88:1, so this deliberately stops short of 2.4.13 Focus Appearance
       (AAA) — a product decision, not an oversight; the two states are told
       apart by hue rather than brightness.
       Do not replace the transparent outline with 'outline: none'. It draws
       nothing in normal rendering, but forced-colors mode swaps it for the
       user's own focus colour — something a recoloured border cannot do, so
       deleting it would leave High Contrast users with no focus indicator. */
    input:focus-visible {
      border-bottom-color: var(--accent);
      outline: 2px solid transparent;
    }
    input:disabled {
      background-color: var(--paper-warm);
      cursor: not-allowed;
    }
    .error {
      color: var(--danger);
      font-size: var(--text-xs);
    }
  `]
})
export class UiInput implements ControlValueAccessor {
  @Input() label: string = '';
  @Input() placeholder: string = '';
  @Input() type: string = 'text';

  // The <input> lives inside this component, so attributes written on
  // <ui-input> itself (autocomplete, aria-label, id...) land on the host
  // element where neither password managers nor screen readers look. Each one
  // a caller needs therefore has to be forwarded explicitly.
  //
  // `inputId`, not `id`: an input named `id` would also leave a static
  // id="..." on the host, giving the page two elements with the same id.
  // A caller whose label sits outside this component (the auth form) passes
  // one and points its own <label for> at it; everyone else gets a generated
  // id so the built-in `label` is still programmatically tied to the field.
  @Input() inputId: string = '';
  @Input() name: string = '';
  @Input() autocomplete: string = '';
  @Input() inputmode: string = '';
  /** The label on the on-screen keyboard's Enter key: 'search', 'send',
   *  'next', 'done'... Unset, phones show a generic return key. */
  @Input() enterkeyhint: string = '';
  // For fields with no visible label, where the placeholder was the only
  // name — and a placeholder is not an accessible name once text is typed.
  @Input() ariaLabel: string = '';
  @Input() ariaDescribedby: string | null = null;

  private readonly generatedId = `ui-input-${++nextInputId}`;

  get controlId(): string {
    return this.inputId || this.generatedId;
  }

  @Input() error: string = '';
  @Input() noMargin: boolean = false;
  // The template already binds this and `input:disabled` is already styled;
  // it just was not reachable from a template. Without it a read-only field
  // had to fall back to a bare <input>, which inherits none of this — the
  // region form ended up with a 33.5px/13.3px native box beside a 40px/15px
  // ui-input, two fields from visibly different designs sitting one above
  // the other.
  //
  // Angular Forms writes the same field through setDisabledState() below, so
  // a control disabled by a form and one disabled by this input converge.
  @Input() disabled: boolean = false;

  value: string = '';

  // Seeds the displayed text without a form control. `value` itself stays a
  // plain field because ControlValueAccessor owns it — writeValue() below is
  // how Angular Forms sets it, and exposing that same field as an @Input
  // would leave two writers with no defined order. A read-only field that
  // only ever displays a value has no form control to write it, hence this
  // separate, one-way entry point.
  @Input('value') set inputValue(val: any) {
    this.value = (val !== null && val !== undefined) ? String(val) : '';
  }

  onChange = (val: string) => {};
  onTouched = () => {};

  onInputChange(event: Event) {
    const val = (event.target as HTMLInputElement).value;
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
