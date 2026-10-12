import { RegionService } from '../../core/region.service';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminSchoolRequest, SchoolRequestStatus } from '../../core/services/admin.service';
import { parseAdminError } from '../../core/admin-error.util';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';

const STATUSES: SchoolRequestStatus[] = ['pending', 'added', 'rejected'];

/** One row's unsaved edits. Kept apart from the row itself so a failed save
 *  leaves the table showing what the server has, not what was typed. */
interface Draft {
  status: SchoolRequestStatus;
  admin_note: string;
}

/**
 * "Report my school" requests filed from the account page's verification
 * form. Staff read them here, add the School on the schools page when it is
 * real, and record the outcome — setting "added" does not create anything.
 */
@Component({
  selector: 'app-admin-school-requests-list',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiButton, UiDropdown, UiPagination, UiSearchBarComponent, AdminBulkBarComponent, AdminPickCellComponent],
  template: `
    <div class="admin-filters">
      <ui-search-bar [placeholder]="'admin.searchSchoolRequests' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
      <ui-dropdown [label]="'admin.colStatus' | t" [options]="statusFilterOptions" [(ngModel)]="statusFilter" (ngModelChange)="onFilterChange()" [searchable]="false"></ui-dropdown>
    </div>

    <admin-bulk-bar *ngIf="!loading && !loadError && requests.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button *ngFor="let s of statusOptions" size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkStatus(s.value)">{{
        'admin.bulk.markAs' | t: { status: s.label }
      }}</ui-button>
    </admin-bulk-bar>

    <ui-skeleton *ngIf="loading" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="reload()"></ui-error-state>

    <div class="table-container">
      <table class="admin-table" *ngIf="!loading && !loadError">
        <thead>
          <tr>
            <th adminPick
              [checked]="bulk.selection.allOf(pageIds)"
              [indeterminate]="bulk.selection.size > 0 && !bulk.selection.allOf(pageIds)"
              [disabled]="bulk.busy || !pageIds.length"
              [label]="'admin.bulk.selectAll' | t"
              (toggle)="bulk.selection.toggleAll(pageIds)"></th>
            <th class="nowrap">{{ 'admin.colRegion' | t }}</th>
            <th>{{ 'admin.colSchool' | t }}</th>
            <th>{{ 'admin.colWebsite' | t }}</th>
            <th>{{ 'admin.colReporter' | t }}</th>
            <th class="nowrap">{{ 'admin.colSubmittedAt' | t }}</th>
            <th class="nowrap">{{ 'admin.colStatus' | t }}</th>
            <th>{{ 'admin.colAdminNote' | t }}</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let req of requests; trackBy: trackById" [class.picked]="bulk.selection.has(req.id)">
            <td adminPick
              [checked]="bulk.selection.has(req.id)"
              [disabled]="bulk.busy"
              [label]="'admin.bulk.selectRow' | t: { name: req.school_name }"
              (toggle)="bulk.selection.toggle(req.id)"></td>
            <td class="nowrap">{{ getRegionName(req.region) }}</td>
            <td class="text-cell">{{ req.school_name }}</td>
            <!-- Typed by a member of the public: opened in a new tab with no
                 opener and no referrer, so the page cannot reach back into
                 the admin session or learn the admin URL it came from. -->
            <td class="text-cell"><a [attr.href]="safeHref(req.school_website)" target="_blank" rel="noopener noreferrer">{{ req.school_website }}</a></td>
            <td class="text-cell">
              <a [regionLink]="['/admin/users', req.user.id]">{{ req.user.email }}</a>
              <div *ngIf="req.edu_email" class="sub-note">{{ 'admin.schoolRequestTypedEmail' | t:{ email: req.edu_email } }}</div>
            </td>
            <td class="nowrap">{{ req.created_at | date:'yyyy/MM/dd HH:mm' }}</td>
            <td class="nowrap">
              <span class="admin-status-badge" [class.warn]="req.status === 'pending'" [class.ok]="req.status === 'added'">{{ ('admin.schoolRequestStatus.' + req.status) | t }}</span>
            </td>
            <td class="edit-cell">
              <ui-dropdown
                [options]="statusOptions"
                [(ngModel)]="drafts[req.id].status"
                [searchable]="false"
                [compact]="true"
                [triggerAriaLabel]="'admin.colStatus' | t"
              ></ui-dropdown>
              <textarea
                class="admin-form-control"
                rows="2"
                maxlength="2000"
                [(ngModel)]="drafts[req.id].admin_note"
                [placeholder]="'admin.schoolRequestNotePlaceholder' | t"
                [attr.aria-label]="'admin.colAdminNote' | t"
              ></textarea>
              <ui-button size="sm" (onClick)="save(req)" [disabled]="savingId === req.id || !isDirty(req)">{{ 'common.save' | t }}</ui-button>
            </td>
          </tr>
          <tr *ngIf="requests.length === 0">
            <td colspan="8" class="empty-note">{{ (hasFilters ? 'common.noMatches' : 'common.noData') | t }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
  `,
  styles: [`
    .sub-note { font-size: var(--text-xs); color: var(--muted); margin-top: 2px; }
    /* Names, URLs and addresses typed by the public: without a floor the note
       column's 200px squeezed these to a few characters per line, and a URL
       with no break points then wrapped one letter at a time. They wrap only
       where they must, and the table scrolls sideways when it runs out. */
    .text-cell { min-width: 160px; max-width: 280px; overflow-wrap: anywhere; }
    .edit-cell { display: flex; flex-direction: column; gap: 6px; min-width: 200px; }
    .edit-cell textarea { resize: vertical; font: inherit; font-size: var(--text-sm); }
    .edit-cell ui-button { align-self: flex-start; }
  `]
})
export class AdminSchoolRequestsListComponent implements OnInit {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private regionService = inject(RegionService);

  requests: AdminSchoolRequest[] = [];
  drafts: Record<number, Draft> = {};
  total = 0;
  page = 1;
  pageSize = 20;
  q = '';
  // Opens on the queue that needs work; "all" is one option away.
  statusFilter: SchoolRequestStatus | '' = 'pending';
  loading = true;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  savingId: number | null = null;
  bulk = new BulkController<number>(() => this.reload());

  get pageIds(): number[] {
    return this.requests.map((r) => r.id);
  }

  get hasFilters(): boolean {
    return !!(this.q || this.statusFilter);
  }

  get statusOptions() {
    return STATUSES.map(s => ({ value: s, label: this.i18n.t('admin.schoolRequestStatus.' + s) }));
  }

  get statusFilterOptions() {
    return [{ value: '', label: this.i18n.t('admin.filterAll') }, ...this.statusOptions];
  }

  getRegionName(code?: string): string {
    if (!code) return '';
    const reg = this.regionService.regions().find((r: any) => r.code?.toUpperCase() === code.toUpperCase());
    return reg ? reg.localized_name : code;
  }

  /** The backend only stores http(s) URLs, but this is the one place a
   *  user-supplied string becomes a clickable href in the admin console, so
   *  it is checked again here rather than trusted. */
  safeHref(url: string): string | null {
    return /^https?:\/\//i.test(url || '') ? url : null;
  }

  trackById(_: number, req: AdminSchoolRequest) {
    return req.id;
  }

  isDirty(req: AdminSchoolRequest): boolean {
    const d = this.drafts[req.id];
    return !!d && (d.status !== req.status || d.admin_note !== (req.admin_note || ''));
  }

  ngOnInit() {
    this.reload();
  }

  onSearch(q: string) {
    this.q = q;
    this.page = 1;
    this.reload();
  }

  onFilterChange() {
    this.page = 1;
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
    this.adminService.getSchoolRequests({
      page: this.page,
      q: this.q,
      status: this.statusFilter,
      region: this.regionService.region().toUpperCase(),
    }).subscribe({
      next: (res) => {
        this.requests = res.results;
        this.total = res.count;
        this.drafts = {};
        for (const req of res.results) this.resetDraft(req);
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

  bulkStatus(status: SchoolRequestStatus) {
    this.bulk.run((id) => this.adminService.updateSchoolRequest(id, { status }), {
      confirm: this.i18n.t('admin.bulk.confirmMarkAs', {
        n: this.bulk.selection.size,
        status: this.i18n.t('admin.schoolRequestStatus.' + status),
      }),
      confirmLabel: this.i18n.t('admin.bulk.markAs', { status: this.i18n.t('admin.schoolRequestStatus.' + status) }),
    });
  }

  save(req: AdminSchoolRequest) {
    const draft = this.drafts[req.id];
    if (!draft || !this.isDirty(req)) return;
    const changes: { status?: SchoolRequestStatus; admin_note?: string } = {};
    if (draft.status !== req.status) changes.status = draft.status;
    if (draft.admin_note !== (req.admin_note || '')) changes.admin_note = draft.admin_note;

    this.savingId = req.id;
    this.adminService.updateSchoolRequest(req.id, changes).subscribe({
      next: (updated) => {
        this.savingId = null;
        // Replaced in place rather than reloaded: under the "pending" filter
        // a reload would drop the row the admin just acted on before they
        // see the save land.
        this.requests = this.requests.map(r => r.id === updated.id ? updated : r);
        this.resetDraft(updated);
        this.toast.success(this.i18n.t('admin.saved'));
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.savingId = null;
        this.toast.error(parseAdminError(err, this.i18n, 'admin.errGeneric'));
        this.cdr.markForCheck();
      }
    });
  }

  private resetDraft(req: AdminSchoolRequest) {
    this.drafts[req.id] = { status: req.status, admin_note: req.admin_note || '' };
  }
}
