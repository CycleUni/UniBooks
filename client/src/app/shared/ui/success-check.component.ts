import { Component, Input } from '@angular/core';

/** The green ring-and-tick used for "done" states; replaces the ✅ emoji, which looks different on every platform. */
@Component({
  selector: 'ui-success-check',
  standalone: true,
  template: `
    <svg [attr.width]="size" [attr.height]="size" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="32" cy="32" r="30" stroke="var(--success)" stroke-width="4" fill="none" />
      <path d="M20 32 L28 46 L44 20" stroke="var(--success)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none" />
    </svg>
  `,
  styles: [`
    :host { display: inline-flex; vertical-align: middle; }
    svg { display: block; }
  `],
})
export class UiSuccessCheck {
  @Input() size = 64;
}
