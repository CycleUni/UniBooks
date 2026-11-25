import { ChangeDetectionStrategy, Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiDropdown, DropdownOption } from '../../shared/ui/dropdown.component';

export type RequestDuration = 'half_year' | 'unlimited';

/**
 * How long a request (a book or a course the student asked to hear about) lasts: half a year by
 * default, or without an end. Picking "half a year" again starts the half year over from today.
 */
@Component({
  selector: 'app-request-expiry',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DatePipe, TPipe, UiDropdown],
  template: `
    <div class="request-expiry">
      <ui-dropdown
        [compact]="true"
        [inlineLabel]="true"
        [searchable]="false"
        [label]="'acct.expiry' | t"
        [options]="options"
        [disabled]="disabled"
        [ngModel]="expiresAt ? 'half_year' : 'unlimited'"
        (ngModelChange)="durationChange.emit($event)"
      ></ui-dropdown>
      <span class="expiry-date" *ngIf="expiresAt">{{ 'acct.expiresOn' | t:{ date: (expiresAt | date:'yyyy/MM/dd') ?? '' } }}</span>
    </div>
  `,
  styles: [`
    .request-expiry { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .expiry-date { color: var(--muted); font-size: var(--text-sm); }
  `],
})
export class RequestExpiryComponent {
  private i18n = inject(I18nService);

  /** When the request lapses (ISO); null = never. */
  @Input() expiresAt: string | null = null;
  @Input() disabled = false;
  @Output() durationChange = new EventEmitter<RequestDuration>();

  get options(): DropdownOption[] {
    return [
      { value: 'half_year', label: this.i18n.t('acct.expiryHalfYear') },
      { value: 'unlimited', label: this.i18n.t('acct.expiryUnlimited') },
    ];
  }
}
