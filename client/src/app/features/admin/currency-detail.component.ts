import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminCurrency } from '../../core/services/admin.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { parseAdminError } from '../../core/admin-error.util';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiButton } from '../../shared/ui/button.component';

@Component({
  selector: 'app-admin-currency-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TPipe, UiErrorState, UiSkeleton, RegionLinkDirective, UiDropdown, UiInput, UiButton, UiCheckbox],
  template: `
    <ui-skeleton *ngIf="!item && !loadError" variant="form" [count]="4"></ui-skeleton>
    <!-- A failed load used to bounce back to the list without a word. -->
    <ui-error-state *ngIf="!item && loadError" [message]="loadError" (retry)="load()"></ui-error-state>
    <div class="admin-detail-header" *ngIf="item">
      <a [regionLink]="['/admin', 'currencies']" class="back-link">&larr; {{ 'admin.backToList' | t }}</a>
      <h2>{{ 'admin.editCurrency' | t }} - {{ item.code }}</h2>
    </div>

    <div class="detail-card" *ngIf="item">
      <div class="form-group">
        <label>{{ 'admin.currencyCode' | t }}</label>
        <ui-input [value]="item.code" [disabled]="true"></ui-input>
      </div>
      <ui-input [label]="'admin.currencySymbol' | t" [(ngModel)]="item.symbol"></ui-input>
      <div class="form-group">
        <label>{{ 'admin.currencyDecimals' | t }}</label>
        <p class="text-hint">{{ 'admin.decimalsWarning' | t }}</p>
        <ui-input type="number" [value]="item.decimal_places" [disabled]="true"></ui-input>
      </div>
      
      <ui-dropdown [label]="'admin.currencySymbolPos' | t" [options]="symbolPosOptions" [(ngModel)]="item.symbol_position"></ui-dropdown>

      <div class="toggle-row">
        <ui-checkbox [(ngModel)]="item.is_active" [label]="'admin.regionIsActive' | t"></ui-checkbox>
      </div>
      
      <div *ngIf="errorMsg" class="inline-msg error">{{ errorMsg }}</div>
      <div *ngIf="savedMsg" class="inline-msg ok">{{ savedMsg }}</div>

      <ui-button (onClick)="save()" [disabled]="saving">{{ (saving ? 'admin.saving' : 'admin.save') | t }}</ui-button>
    </div>
  `,
  styles: [`
    .detail-card {
      background: var(--surface-card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      max-width: 520px;
      box-shadow: var(--shadow-card-lg);
    }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-size: var(--text-base); font-weight: 600; }
    .text-hint { font-size: var(--text-sm); color: var(--muted); margin-top: -4px; margin-bottom: 8px; }
    .toggle-row {
      display: flex;
      gap: 24px;
      margin: 16px 0;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: var(--text-base);
      cursor: pointer;
    }
  `]
})
export class AdminCurrencyDetailComponent implements OnInit {
  private adminService = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);
  private route = inject(ActivatedRoute);
  private i18n = inject(I18nService);

  item?: AdminCurrency;
  saving = false;
  errorMsg = '';
  savedMsg = '';

  symbolPosOptions = [
    { value: 'prefix', label: 'prefix' },
    { value: 'suffix', label: 'suffix' }
  ];

  /** Why the last load failed. */
  loadError = '';

  ngOnInit() {
    this.load();
  }

  load() {
    const code = this.route.snapshot.paramMap.get('id');
    this.loadError = '';
    if (code) {
      this.adminService.getCurrency(code).subscribe({
        next: (res) => {
          this.item = res;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.cdr.markForCheck();
        }
      });
    }
  }

  save() {
    if (!this.item) return;
    this.saving = true;
    this.errorMsg = '';
    this.savedMsg = '';
    this.cdr.markForCheck();

    // Create a copy and remove immutable fields just in case
    const payload = { ...this.item };
    delete (payload as any).code;
    delete (payload as any).decimal_places;

    this.adminService.updateCurrency(this.item.code, payload).subscribe({
      next: () => {
        this.saving = false;
        this.savedMsg = this.i18n.t('admin.saved');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.saving = false;
        this.errorMsg = parseAdminError(err, this.i18n);
        this.cdr.markForCheck();
      }
    });
  }
}
