import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminReport } from '../../core/services/admin.service';
import { parseAdminError } from '../../core/admin-error.util';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';

@Component({
  selector: 'app-admin-reports-list',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiButton, UiDropdown, UiPagination, AdminBulkBarComponent, AdminPickCellComponent],
  template: `
    <div class="admin-filters">
      <ui-dropdown [label]="'admin.colStatus' | t" [options]="statusOptions" [(ngModel)]="statusFilter" (ngModelChange)="reload()" [searchable]="false"></ui-dropdown>
    </div>

    <admin-bulk-bar *ngIf="!loading && !loadError && statusFilter === 'open' && reports.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button size="sm" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkAction('actioned')">{{ 'admin.bulk.handle' | t }}</ui-button>
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkAction('dismissed')">{{ 'admin.reportActionDismiss' | t }}</ui-button>
    </admin-bulk-bar>

    <ui-skeleton *ngIf="loading" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="reload()"></ui-error-state>

    <table class="admin-table" *ngIf="!loading && !loadError">
      <thead>
        <tr>
          <th *ngIf="statusFilter === 'open'" adminPick
            [checked]="bulk.selection.allOf(pageIds)"
            [indeterminate]="bulk.selection.size > 0 && !bulk.selection.allOf(pageIds)"
            [disabled]="bulk.busy || !pageIds.length"
            [label]="'admin.bulk.selectAll' | t"
            (toggle)="bulk.selection.toggleAll(pageIds)"></th>
          <th>{{ 'admin.colRegion' | t }}</th>
          <th>{{ 'admin.colReporter' | t }}</th>
          <th>{{ 'admin.colListing' | t }}</th>
          <th>{{ 'admin.colReason' | t }}</th>
          <th>{{ 'admin.colStatus' | t }}</th>
          <th *ngIf="statusFilter === 'open'"></th>
        </tr>
      </thead>
      <tbody>
        <tr *ngFor="let report of reports" [class.picked]="bulk.selection.has(report.id)">
          <td *ngIf="statusFilter === 'open'" adminPick
            [checked]="bulk.selection.has(report.id)"
            [disabled]="bulk.busy || report.status !== 'open'"
            [label]="'admin.bulk.selectRow' | t: { name: report.listing?.title || report.id }"
            (toggle)="bulk.selection.toggle(report.id)"></td>
          <td>{{ getRegionName(report.region) }}</td>
          <td>{{ report.reporter?.email }}</td>
          <td>
            <a *ngIf="!report.listing?.deleted" [regionLink]="['/listing', report.listing?.id]">{{ report.listing?.title || report.listing?.id }}</a>
            <span *ngIf="report.listing?.deleted">{{ report.listing?.title }} <span class="text-muted">· {{ 'common.listingDeleted' | t }}</span></span>
          </td>
          <td>{{ ('moderation.reason' + reasonSuffix(report.reason)) | t }}</td>
          <td><span class="admin-status-badge" [class.warn]="report.status === 'open'">{{ ('admin.reportStatus.' + report.status) | t }}</span></td>
          <td *ngIf="report.status === 'open'" class="actions-cell">
            <!-- Nothing left to take down once the seller deleted it; the
                 same action then only records the report as handled. -->
            <ui-button (onClick)="action(report, 'actioned')" [disabled]="actingId === report.id">{{ (report.listing?.deleted ? 'admin.reportActionFlag' : 'admin.reportActionRemove') | t }}</ui-button>
            <ui-button variant="ghost" (onClick)="action(report, 'dismissed')" [disabled]="actingId === report.id">{{ 'admin.reportActionDismiss' | t }}</ui-button>
          </td>
        </tr>
        <!-- Stays noMatches unconditionally: statusOptions has no "all"
             entry, so this table is always scoped to one status and an empty
             result always means "none with this status", never "no reports". -->
        <tr *ngIf="reports.length === 0">
          <td colspan="7" class="empty-note">{{ 'common.noMatches' | t }}</td>
        </tr>
      </tbody>
    </table>

    <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
  `,
  styles: [`
    .actions-cell { display: flex; gap: 8px; }
  `]
})
export class AdminReportsListComponent implements OnInit {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);

  reports: AdminReport[] = [];
  total = 0;
  page = 1;
  pageSize = 20;
  statusFilter = 'open';
  loading = true;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  actingId: string | null = null;
  bulk = new BulkController<string>(() => this.reload());

  get pageIds(): string[] {
    return this.reports.filter((r) => r.status === 'open').map((r) => r.id);
  }

  getRegionName(code?: string): string {
    if (!code) return '';
    const reg = this.regionService.regions().find((r: any) => r.code === code);
    return reg ? reg.localized_name : code;
  }

  get statusOptions() {
    return [
      { value: 'open', label: this.i18n.t('admin.reportStatus.open') },
      { value: 'actioned', label: this.i18n.t('admin.reportStatus.actioned') },
      { value: 'dismissed', label: this.i18n.t('admin.reportStatus.dismissed') },
    ];
  }

  reasonSuffix(reason: string): string {
    // Backend reason values (fake/scam/other) map onto the existing
    // moderation.reasonFake/reasonScam/reasonOther i18n keys.
    if (reason === 'fake') return 'Fake';
    if (reason === 'scam') return 'Scam';
    return 'Other';
  }

  ngOnInit() {
    this.reload();
  }

  onPageChange(page: number) {
    this.page = page;
    this.reload();
  }

  reload() {
    this.bulk.reset();
    this.loading = true;
    this.loadError = '';
    this.adminService.getReports(this.statusFilter, this.page, this.regionService.region().toUpperCase()).subscribe({
      next: (res) => {
        this.reports = res.results;
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

  bulkAction(status: 'actioned' | 'dismissed') {
    const n = this.bulk.selection.size;
    this.bulk.run((id) => this.adminService.actionReport(id, status), {
      confirm: this.i18n.t(status === 'actioned' ? 'admin.bulk.confirmHandleReports' : 'admin.bulk.confirmDismissReports', { n }),
      confirmLabel: this.i18n.t(status === 'actioned' ? 'admin.bulk.handle' : 'admin.reportActionDismiss'),
    });
  }

  action(report: AdminReport, status: 'actioned' | 'dismissed') {
    this.actingId = report.id;
    this.adminService.actionReport(report.id, status).subscribe({
      next: () => {
        this.actingId = null;
        this.reload();
      },
      error: (err) => {
        this.toast.error(parseAdminError(err, this.i18n, 'admin.errGeneric'));
        this.actingId = null;
        this.cdr.markForCheck();
      }
    });
  }
}
