import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminListing } from '../../core/services/admin.service';
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

@Component({
  selector: 'app-admin-listings-list',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiSearchBarComponent, UiDropdown, UiPagination, PricePipe, UiButton, AdminBulkBarComponent, AdminPickCellComponent, AdminBulkReasonModalComponent],
  template: `
    <div class="admin-filters">
      <ui-search-bar [placeholder]="'admin.searchListings' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
      <ui-dropdown [label]="'admin.colStatus' | t" [options]="statusOptions" [(ngModel)]="statusFilter" (ngModelChange)="reload()" [searchable]="false"></ui-dropdown>
    </div>

    <admin-bulk-bar *ngIf="!loading && !loadError && listings.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkLock()">{{ 'admin.bulk.lock' | t }}</ui-button>
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkUnlock()">{{ 'admin.bulk.unlock' | t }}</ui-button>
      <ui-button size="sm" variant="danger" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkDelete()">{{ 'common.delete' | t }}</ui-button>
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
          <th>{{ 'admin.colSeller' | t }}</th>
          <th>{{ 'admin.colSchool' | t }}</th>
          <th>{{ 'admin.colPrice' | t }}</th>
          <th>{{ 'admin.colStatus' | t }}</th>
        </tr>
      </thead>
      <tbody>
        <tr *ngFor="let listing of listings" [regionLink]="[listing.id]" [class.picked]="bulk.selection.has(listing.id)">
          <td adminPick
            [checked]="bulk.selection.has(listing.id)"
            [disabled]="bulk.busy"
            [label]="'admin.bulk.selectRow' | t: { name: listing.book?.title || listing.id }"
            (toggle)="bulk.selection.toggle(listing.id)"></td>
          <td>{{ getRegionName(listing.region) }}</td>
          <td>{{ listing.book?.title }}</td>
          <td>{{ listing.seller?.email }}</td>
          <td>{{ listing.school?.display_name || listing.school?.name }}</td>
          <td>{{ listing.price | price: listing.currency }}</td>
          <td>
            <span class="admin-status-badge">{{ ('admin.listingStatus.' + listing.status) | t }}</span>
            <span *ngIf="listing.admin_locked" class="admin-status-badge locked" [attr.title]="listing.admin_lock_reason || null">{{ 'admin.locked' | t }}</span>
          </td>
        </tr>
        <tr *ngIf="listings.length === 0">
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
export class AdminListingsListComponent implements OnInit {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);

  listings: AdminListing[] = [];
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
    return this.listings.map((l) => l.id);
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
      { value: 'active', label: this.i18n.t('admin.listingStatus.active') },
      { value: 'reserved', label: this.i18n.t('admin.listingStatus.reserved') },
      { value: 'sold', label: this.i18n.t('admin.listingStatus.sold') },
      { value: 'removed', label: this.i18n.t('admin.listingStatus.removed') },
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

  bulkLock() {
    const n = this.bulk.selection.size;
    this.bulk.runWithReason(
      {
        title: this.i18n.t('admin.bulk.lockTitle', { n }),
        message: this.i18n.t('admin.bulk.lockMessage'),
        label: this.i18n.t('admin.lockReason'),
        placeholder: '',
        submitLabel: this.i18n.t('admin.bulk.lock'),
        minLength: 0,
        danger: false,
      },
      (id, reason) => this.adminService.updateListingStatus(id, { admin_locked: true, admin_lock_reason: reason }),
    );
  }

  bulkUnlock() {
    this.bulk.run((id) => this.adminService.updateListingStatus(id, { admin_locked: false }), {
      confirm: this.i18n.t('admin.bulk.confirmUnlock', { n: this.bulk.selection.size }),
      confirmLabel: this.i18n.t('admin.bulk.unlock'),
    });
  }

  /** One reason for all: a listing with open orders has them cancelled
   *  with it before it goes, as on its own page. */
  bulkDelete() {
    const n = this.bulk.selection.size;
    this.bulk.runWithReason(
      {
        title: this.i18n.t('admin.bulk.deleteListingsTitle', { n }),
        message: this.i18n.t('admin.bulk.deleteListingsMessage'),
        label: this.i18n.t('admin.forceCancelReasonLabel'),
        placeholder: this.i18n.t('admin.forceCancelReasonPlaceholder'),
        submitLabel: this.i18n.t('common.delete'),
        minLength: 3,
        danger: true,
      },
      (id, reason) => this.adminService.deleteListing(id, reason),
    );
  }

  reload() {
    this.bulk.reset();
    this.loading = true;
    this.loadError = '';
    this.adminService.getListings({ page: this.page, q: this.q, status: this.statusFilter, region: this.regionService.region().toUpperCase() }).subscribe({
      next: (res) => {
        this.listings = res.results;
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
