import { Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * The tick box cell of an admin table's selection column, `<td adminPick>`
 * on a row or `<th adminPick>` for "select all". The whole cell is the
 * label, so the tap target is at least --tap-min, and a click in it stops
 * there, so ticking a row does not open the page the row links to. State
 * comes in as plain inputs: the list's OnPush check passes them down.
 */
@Component({
  selector: 'td[adminPick], th[adminPick]',
  standalone: true,
  host: { class: 'pick', '(click)': '$event.stopPropagation()' },
  template: `
    <label class="pick-box">
      <input
        type="checkbox"
        [checked]="checked"
        [indeterminate]="indeterminate"
        [disabled]="disabled"
        (change)="toggle.emit()"
        [attr.aria-label]="label"
      />
    </label>
  `,
})
export class AdminPickCellComponent {
  @Input() checked = false;
  @Input() indeterminate = false;
  @Input() disabled = false;
  /** Already translated: which row this ticks, or "select all". */
  @Input() label = '';
  @Output() toggle = new EventEmitter<void>();
}
