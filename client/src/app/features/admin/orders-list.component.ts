import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminOrder } from '../../core/services/admin.service';
import { parseAdminError } from '../../core/admin-error.util';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';
import { AdminBulkReasonModalComponent } from './bulk-reason-modal.component';
import { UiButton } from '../../shared/ui/button.component';

const FINAL_STATUSES = new Set(['cancelled', 'completed']);

@Component({
  selector: 'app-admin-orders-list',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiSearchBarComponent, UiDropdown, UiPagination, PricePipe, UiButton, AdminBulkBarComponent, AdminPickCellComponent, AdminBulkReasonModalComponent],
  template: `
    <div class="admin-filters">
      <ui-search-bar [placeholder]="'admin.searchOrders' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
      <ui-dropdown [label]="'admin.colStatus' | t" [options]="statusOptions" [(ngModel)]="statusFilter" (ngModelChange)="reload()" [searchable]="false"></ui-dropdown>
    </div>

    <admin-bulk-bar *ngIf="!loading && !loadError && orders.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button size="sm" variant="danger" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkCancel()">{{ 'admin.forceCancelButton' | t }}</ui-button>
    </admin-bulk-bar>
    <admin-bulk-reason-modal
      *ngIf="bulk.reasonPrompt as p"
      [title]="p.title" [message]="p.message" [label]="p.label" [placeholder]="p.placeholder"
      [submitLabel]="p.submitLabel" [minLength]="p.minLength" [danger]="p.danger"
      (submitted)="p.run($event)" (closed)="bulk.reasonPrompt = null"
    ></admin-bulk-reason-modal>

    <ui-skeleton *ngIf="loading" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="reload()"></ui-error-state>

    <div class="table-container">


      <table class="admin-table admin-table-clickable" *ngIf="!loading && !loadError">
      <thead>
        <tr>
          <th adminPick
            [checked]="bulk.selection.allOf(pageIds)"
            [indeterminate]="bulk.selection.size > 0 && !bulk.selection.allOf(pageIds)"
            [disabled]="bulk.busy || !pageIds.length"
            [label]="'admin.bulk.selectAll' | t"
            (toggle)="bulk.selection.toggleAll(pageIds)"></th>
          <th>{{ 'admin.colRegion' | t }}</th>
          <th>{{ 'admin.colBook' | t }}</th>
          <th>{{ 'order.buyer' | t }}</th>
          <th>{{ 'order.seller' | t }}</th>
          <th>{{ 'admin.colPrice' | t }}</th>
          <th>{{ 'admin.colStatus' | t }}</th>
        </tr>
      </thead>
      <tbody>
        <tr *ngFor="let order of orders" [regionLink]="[order.id]" [class.picked]="bulk.selection.has(order.id)">
          <td adminPick
            [checked]="bulk.selection.has(order.id)"
            [disabled]="bulk.busy || isFinal(order)"
            [label]="'admin.bulk.selectRow' | t: { name: order.listing?.book_title || order.id }"
            (toggle)="bulk.selection.toggle(order.id)"></td>
          <td>{{ getRegionName(order.region) }}</td>
          <td>{{ order.listing?.book_title }}<span *ngIf="order.listing?.deleted" class="text-muted"> · {{ 'common.listingDeleted' | t }}</span></td>
          <td>{{ order.buyer?.email }}</td>
          <td>{{ order.seller?.email }}</td>
          <td>{{ order.total_amount | price: order.currency }}</td>
          <td><span class="admin-status-badge">{{ ('order.status.' + order.status) | t }}</span></td>
        </tr>
        <tr *ngIf="orders.length === 0">
          <td colspan="7" class="empty-note">{{ (hasFilters ? 'common.noMatches' : 'common.noData') | t }}</td>
        </tr>
      </tbody>
    </table>


    </div>

    <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
  `,
  styles: [`
  `]
})
export class AdminOrdersListComponent implements OnInit {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);

  orders: AdminOrder[] = [];
  total = 0;
  page = 1;
  pageSize = 20;
  q = '';
  statusFilter = '';
  loading = true;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  bulk = new BulkController<string>(() => this.reload());

  get pageIds(): string[] {
    return this.orders.filter((o) => !FINAL_STATUSES.has(o.status)).map((o) => o.id);
  }

  /** Whether the table the admin is looking at is narrowed by anything. An
   *  empty result then means "nothing matched", which is a different fact
   *  from "this table has no rows at all" — and only the second one should
   *  read as an empty-table message. */
  get hasFilters(): boolean {
    return !!(this.q || this.statusFilter);
  }

  getRegionName(code?: string): string {
    if (!code) return '';
    const reg = this.regionService.regions().find(r => r.code === code);
    return reg ? reg.localized_name : code;
  }

  get statusOptions() {
    return [
      { value: '', label: this.i18n.t('admin.filterAll') },
      { value: 'pending', label: this.i18n.t('order.status.pending') },
      { value: 'accepted', label: this.i18n.t('order.status.accepted') },
      { value: 'handed_over', label: this.i18n.t('order.status.handed_over') },
      { value: 'completed', label: this.i18n.t('order.status.completed') },
      { value: 'cancelled', label: this.i18n.t('order.status.cancelled') },
    ];
  }

  ngOnInit() {
    this.reload();
  }

  onSearch(q: string) {
    this.q = q;
    this.page = 1;
    this.reload();
  }

  onPageChange(page: number) {
    this.page = page;
    this.reload();
  }

  /** Cancelled and completed orders are over: nothing left to cancel. */
  isFinal(order: AdminOrder): boolean {
    return FINAL_STATUSES.has(order.status);
  }

  bulkCancel() {
    const n = this.bulk.selection.size;
    this.bulk.runWithReason(
      {
        title: this.i18n.t('admin.bulk.forceCancelTitle', { n }),
        message: this.i18n.t('admin.bulk.forceCancelMessage'),
        label: this.i18n.t('admin.forceCancelReasonLabel'),
        placeholder: this.i18n.t('admin.forceCancelReasonPlaceholder'),
        submitLabel: this.i18n.t('admin.forceCancelSubmit'),
        minLength: 3,
        danger: true,
      },
      (id, reason) => this.adminService.forceCancelOrder(id, reason),
    );
  }

  reload() {
    this.bulk.reset();
    this.loading = true;
    this.loadError = '';
    this.adminService.getOrders({ page: this.page, q: this.q, status: this.statusFilter, region: this.regionService.region().toUpperCase() }).subscribe({
      next: (res) => {
        this.orders = res.results;
        this.total = res.count;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.loading = false;
        this.cdr.markForCheck();
      }
    });
  }
}
