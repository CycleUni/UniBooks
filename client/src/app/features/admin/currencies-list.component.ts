import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminCurrency, Paginated } from '../../core/services/admin.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { parseAdminError } from '../../core/admin-error.util';

@Component({
  selector: 'app-admin-currencies-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiPagination, UiDropdown, UiInput, UiButton, UiErrorState, UiCheckbox, UiFocusTrapDirective],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navCurrencies' | t }}</h2>
      <ui-button (onClick)="openCreateModal()">{{ 'admin.addCurrency' | t }}</ui-button>
    </div>

    <ui-skeleton *ngIf="!data && loading" variant="table" [count]="5"></ui-skeleton>
    <!-- A failed load used to leave the page with its heading and nothing
         under it, which read as an empty list rather than an error. -->
    <ui-error-state
      *ngIf="loadFailed"
      [message]="'admin.errLoadFailed' | t"
      (retry)="loadPage(currentPage)"
    ></ui-error-state>
    <div class="table-container" *ngIf="data && !loadFailed">
      <table class="admin-table">
        <thead>
          <tr>
            <th>{{ 'admin.currencyCode' | t }}</th>
            <th>{{ 'admin.currencySymbol' | t }}</th>
            <th>{{ 'admin.currencyDecimals' | t }}</th>
            <th>{{ 'admin.regionIsActive' | t }}</th>
            <th>{{ 'admin.colActions' | t }}</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let item of data.results">
            <td>{{ item.code }}</td>
            <td>{{ item.symbol }}</td>
            <td>{{ item.decimal_places }}</td>
            <td>{{ item.is_active ? ('admin.yes' | t) : ('admin.no' | t) }}</td>
            <td>
              <ui-button size="sm" variant="outline" [link]="[item.code]">{{ 'common.edit' | t }}</ui-button>
            </td>
          </tr>
        </tbody>
      </table>

      <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="currentPage" (pageChange)="loadPage($event)"></ui-pagination>
    </div>

    <div class="app-modal-overlay" *ngIf="showCreateModal" (click)="showCreateModal = false">
      <div class="app-modal"  style="width: 400px; max-width: 90%;" (click)="$event.stopPropagation()" uiFocusTrap="currencies-modal-title" (escape)="showCreateModal = false">
        <h3 id="currencies-modal-title" class="app-modal-title">{{ 'admin.addCurrency' | t }}</h3>
        <div class="app-modal-body">
          <ui-input [label]="'admin.currencyCode' | t" [(ngModel)]="newItem.code"></ui-input>
          <ui-input [label]="'admin.currencySymbol' | t" [(ngModel)]="newItem.symbol"></ui-input>
          <ui-input [label]="'admin.currencyDecimals' | t" type="number" [(ngModel)]="newItem.decimal_places"></ui-input>
          
          <ui-dropdown [label]="'admin.currencySymbolPos' | t" [options]="symbolPosOptions" [(ngModel)]="newItem.symbol_position"></ui-dropdown>

          <div class="form-group">
            <ui-checkbox [(ngModel)]="newItem.is_active" [label]="'admin.regionIsActive' | t"></ui-checkbox>
          </div>
          
          <div *ngIf="errorMsg" class="inline-msg error">{{ errorMsg }}</div>
        </div>
        <div class="app-modal-actions"  style="display: flex; justify-content: flex-end; gap: 8px; padding-top: 16px;">
          <ui-button variant="ghost" (onClick)="showCreateModal = false" [disabled]="saving">{{ 'common.cancel' | t }}</ui-button>
          <ui-button (onClick)="create()" [disabled]="saving">{{ (saving ? 'admin.saving' : 'admin.save') | t }}</ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-size: var(--text-base); font-weight: 600; }
  `]
})
export class AdminCurrenciesListComponent implements OnInit {
  private adminService = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);

  data?: Paginated<AdminCurrency>;
  loading = true;
  loadFailed = false;
  currentPage = 1;
  total = 0;
  pageSize = 20;

  showCreateModal = false;
  newItem: Partial<AdminCurrency> = { code: '', symbol: '', decimal_places: 0, symbol_position: 'prefix', is_active: true };
  errorMsg = '';
  saving = false;
  
  symbolPosOptions = [
    { value: 'prefix', label: 'prefix' },
    { value: 'suffix', label: 'suffix' }
  ];

  ngOnInit() {
    this.loadPage(1);
  }

  loadPage(page: number) {
    this.currentPage = page;
    this.loadFailed = false;
    this.loading = true;
    this.adminService.getCurrencies().subscribe({
      next: (res) => {
        if (Array.isArray(res)) {
           this.data = { count: res.length, results: res, next: null, previous: null } as any;
           this.total = res.length;
        } else {
           this.data = res;
           this.total = res.count;
        }
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.loading = false;
        this.loadFailed = true;
        this.cdr.markForCheck();
      }
    });
  }

  openCreateModal() {
    this.newItem = { code: '', symbol: '', decimal_places: 0, symbol_position: 'prefix', is_active: true };
    this.errorMsg = '';
    this.saving = false;
    this.showCreateModal = true;
  }

  create() {
    this.errorMsg = '';
    this.saving = true;
    this.adminService.createCurrency(this.newItem).subscribe({
      next: () => {
        this.saving = false;
        this.showCreateModal = false;
        this.loadPage(1);
      },
      error: (err) => {
        this.saving = false;
        this.errorMsg = parseAdminError(err, this.i18n);
        this.cdr.markForCheck();
      }
    });
  }
}
