import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminEmailPipe } from './admin-email.pipe';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { AdminService, AdminBookReport, AdminBook, AdminBookRecord } from '../../core/services/admin.service';
import { AdminBookEditComponent } from './book-edit.component';
import { parseAdminError } from '../../core/admin-error.util';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { AuthStore, isAdminUser } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';

@Component({
  selector: 'app-admin-book-reports-list',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    AdminEmailPipe,
    RegionLinkDirective,
    TPipe,
    UiSkeleton,
    UiErrorState,
    UiButton,
    UiDropdown,
    UiPagination,
    AdminBookEditComponent,
  ],
  template: `
    <div class="admin-filters">
      <ui-dropdown
        [label]="'admin.colStatus' | t"
        [options]="statusOptions"
        [(ngModel)]="statusFilter"
        (ngModelChange)="reload()"
        [searchable]="false"
      ></ui-dropdown>
      <ui-dropdown
        *ngIf="regionOptions.length > 1"
        [label]="'admin.colRegion' | t"
        [options]="regionOptions"
        [(ngModel)]="regionFilter"
        (ngModelChange)="reload()"
        [searchable]="false"
      ></ui-dropdown>
      <ui-dropdown
        [label]="'admin.bookReports.filterField' | t"
        [options]="fieldOptions"
        [(ngModel)]="fieldFilter"
        (ngModelChange)="reload()"
        [searchable]="false"
      ></ui-dropdown>
    </div>

    <ui-skeleton *ngIf="loading && !loaded" variant="spinner"></ui-skeleton>
    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="reload()"></ui-error-state>

    <table class="admin-table admin-table-clickable" *ngIf="loaded && !loadError" [class.stale]="loading">
      <thead>
        <tr>
          <th>{{ 'admin.colRegion' | t }}</th>
          <th>{{ 'admin.colReporter' | t }}</th>
          <th>{{ 'admin.bookReports.colBook' | t }}</th>
          <th>{{ 'admin.bookReports.colFields' | t }}</th>
          <th>{{ 'admin.colStatus' | t }}</th>
        </tr>
      </thead>
      <tbody>
        <ng-container *ngFor="let report of reports">
          <tr class="report-row" (click)="toggleExpand(report)">
            <td>{{ getRegionName(report.region) }}</td>
            <td>{{ report.reporter?.email | adminEmail }}</td>
            <td>
              <a [regionLink]="['/book']" [queryParams]="{ id: report.book.id }" (click)="$event.stopPropagation()">
                {{ report.book?.title || report.book.id }}
              </a>
            </td>
            <td>
              <span class="fields-list">
                <span *ngFor="let f of report.fields" class="field-pill">{{ fieldLabel(f) }}</span>
              </span>
            </td>
            <td>
              <span class="admin-status-badge" [class.warn]="report.status === 'open'" [class.ok]="report.status === 'fixed'">
                {{ ('admin.bookReportStatus.' + report.status) | t }}
              </span>
            </td>
          </tr>

          <!-- Expanded detail row comparing current book data with user's suggested values -->
          <tr class="detail-row" *ngIf="expandedId === report.id">
            <td colspan="5">
              <div class="detail-content">
                <table class="comparison-table">
                  <thead>
                    <tr>
                      <th>{{ 'admin.bookReports.colFields' | t }}</th>
                      <th>{{ 'admin.bookReports.currentValue' | t }}</th>
                      <th>{{ 'admin.bookReports.suggestedValue' | t }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr *ngFor="let f of report.fields">
                      <td class="field-name-cell"><strong>{{ fieldLabel(f) }}</strong></td>
                      <td class="current-val-cell">{{ getCurrentVal(report, f) }}</td>
                      <td class="suggested-val-cell" [class.highlight]="getSuggestedVal(report, f) !== '—'">
                        {{ getSuggestedVal(report, f) }}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <div *ngIf="report.detail" class="report-note">
                  <strong>{{ 'bookReport.detailLabel' | t }}:</strong> {{ report.detail }}
                </div>
                <div *ngIf="report.admin_note" class="report-note admin-note">
                  <strong>{{ 'admin.bookReports.adminNote' | t }}:</strong> {{ report.admin_note }}
                </div>

                <div *ngIf="report.status === 'open'" class="detail-actions">
                  <ui-button size="sm" (onClick)="applyAndFix(report)" [disabled]="actingId === report.id || loadingEdit">
                    {{ 'admin.bookReports.applyAndFix' | t }}
                  </ui-button>
                  <ui-button size="sm" variant="outline" (onClick)="markFixed(report)" [disabled]="actingId === report.id || loadingEdit">
                    {{ 'admin.bookReports.markFixed' | t }}
                  </ui-button>
                  <ui-button size="sm" variant="ghost" (onClick)="startDismiss(report)" [disabled]="actingId === report.id || loadingEdit">
                    {{ 'admin.bookReports.dismiss' | t }}
                  </ui-button>
                </div>
              </div>
            </td>
          </tr>
        </ng-container>

        <tr *ngIf="reports.length === 0">
          <td colspan="5" class="empty-note">
            {{ 'common.noMatches' | t }}
          </td>
        </tr>
      </tbody>
    </table>

    <ui-pagination
      [total]="total"
      [pageSize]="pageSize"
      [currentPage]="page"
      (pageChange)="onPageChange($event)"
    ></ui-pagination>

    <!-- Dismiss dialog with optional note -->
    <div *ngIf="dismissingReport" class="modal-overlay" (click)="cancelDismiss()"></div>
    <div *ngIf="dismissingReport" class="modal-dialog dismiss-dialog" role="dialog" aria-modal="true">
      <h3>{{ 'admin.bookReports.dismissTitle' | t }}</h3>
      <div class="form-group">
        <label for="dismiss-note">{{ 'admin.bookReports.dismissNoteLabel' | t }}</label>
        <textarea
          id="dismiss-note"
          class="admin-form-control"
          rows="3"
          maxlength="2000"
          [(ngModel)]="dismissNote"
          [placeholder]="'admin.bookReports.dismissNotePlaceholder' | t"
        ></textarea>
      </div>
      <div class="modal-actions">
        <ui-button variant="ghost" (onClick)="cancelDismiss()" [disabled]="actingId !== null">
          {{ 'common.cancel' | t }}
        </ui-button>
        <ui-button variant="primary" (onClick)="confirmDismiss()" [disabled]="actingId !== null">
          {{ 'admin.bookReports.dismiss' | t }}
        </ui-button>
      </div>
    </div>

    <!-- Apply & Fix editor modal / drawer -->
    <div *ngIf="activeEditReport && activeEditBook" class="modal-overlay" (click)="closeEditor()"></div>
    <div *ngIf="activeEditReport && activeEditBook" class="modal-dialog editor-dialog" role="dialog" aria-modal="true">
      <div class="editor-header">
        <ui-button size="sm" variant="ghost" (onClick)="closeEditor()">
          {{ 'common.cancel' | t }}
        </ui-button>
      </div>
      <admin-book-edit
        [bookId]="activeEditBookId"
        [book]="activeEditBook"
        [initialForm]="editorInitialForm"
        [reportIdToFix]="activeEditReport.id"
        [currentSource]="activeEditBookSource"
        [initiallyOpen]="true"
        (saved)="onEditorSaved()"
        (merged)="onEditorMerged($event)"
      ></admin-book-edit>
    </div>
  `,
  styles: [`
    .report-row td:first-child,
    .report-row .admin-status-badge,
    th {
      white-space: nowrap;
    }
    .admin-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
    }
    .fields-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .field-pill {
      display: inline-block;
      padding: 2px 6px;
      font-size: var(--text-xs);
      background: var(--paper-warm);
      border-radius: 4px;
      border: 1px solid var(--line);
    }
    .actions-cell {
      display: flex;
      gap: 6px;
      white-space: nowrap;
    }
    .report-row {
      cursor: pointer;
    }
    .detail-row td {
      background: var(--paper-warm);
      padding: 16px;
    }
    .detail-content {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .comparison-table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--text-sm);
      background: var(--surface-raised);
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--line);
    }
    .comparison-table th,
    .comparison-table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--line);
    }
    .comparison-table th {
      background: var(--paper-warm);
      font-weight: 600;
    }
    .suggested-val-cell.highlight {
      color: var(--accent);
      font-weight: 600;
    }
    .report-note {
      padding: 8px 12px;
      background: var(--surface-raised);
      border-radius: 4px;
      border-left: 3px solid var(--accent);
      font-size: var(--text-sm);
    }
    .report-note.admin-note {
      border-left-color: var(--muted);
    }
    .detail-actions {
      display: flex;
      gap: 8px;
    }
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 1000;
    }
    .modal-dialog {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      background: var(--surface-raised);
      padding: 24px;
      border-radius: 8px;
      box-shadow: var(--shadow-card-lg);
      z-index: 1001;
      max-height: 90vh;
      overflow-y: auto;
    }
    .dismiss-dialog {
      width: 100%;
      max-width: 480px;
    }
    .dismiss-dialog h3 {
      margin-top: 0;
      margin-bottom: 12px;
    }
    .dismiss-dialog .form-group {
      margin-bottom: 16px;
    }
    .dismiss-dialog label {
      display: block;
      margin-bottom: 6px;
      font-weight: 600;
      font-size: var(--text-sm);
    }
    .dismiss-dialog textarea {
      width: 100%;
      resize: vertical;
      box-sizing: border-box;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .editor-dialog {
      width: 100%;
      max-width: 680px;
    }
    .editor-header {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 8px;
    }
  `],
})
export class AdminBookReportsListComponent implements OnInit {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);

  reports: AdminBookReport[] = [];
  total = 0;
  page = 1;
  pageSize = 20;

  statusFilter = 'open';
  regionFilter = '';
  fieldFilter = '';

  loading = true;
  loaded = false;
  loadError = '';
  actingId: string | null = null;
  expandedId: string | null = null;

  dismissingReport: AdminBookReport | null = null;
  dismissNote = '';

  loadingEdit = false;
  activeEditReport: AdminBookReport | null = null;
  activeEditBook: AdminBookRecord | null = null;
  activeEditBookId = '';
  activeEditBookSource: string | null = null;

  get statusOptions() {
    return [
      { value: 'open', label: this.i18n.t('admin.bookReportStatus.open') },
      { value: 'fixed', label: this.i18n.t('admin.bookReportStatus.fixed') },
      { value: 'dismissed', label: this.i18n.t('admin.bookReportStatus.dismissed') },
    ];
  }

  get regionOptions() {
    const user = this.authStore.user();
    const staffRegions: string[] | null = user && !isAdminUser(user) ? (user.managed_regions ?? []) : null;
    const regions = this.regionService.regions().filter((r) => !staffRegions || staffRegions.includes(r.code));
    const options = regions.map((r) => ({ value: r.code, label: r.localized_name }));
    if (!staffRegions) {
      return [{ value: '', label: this.i18n.t('admin.allRegions') }, ...options];
    }
    return options;
  }

  get fieldOptions() {
    return [
      { value: '', label: this.i18n.t('admin.bookReports.allFields') },
      { value: 'title', label: this.i18n.t('bookReport.fieldTitle') },
      { value: 'authors', label: this.i18n.t('bookReport.fieldAuthors') },
      { value: 'publisher', label: this.i18n.t('bookReport.fieldPublisher') },
      { value: 'published_date', label: this.i18n.t('bookReport.fieldPublishedDate') },
      { value: 'cover', label: this.i18n.t('bookReport.fieldCover') },
      { value: 'isbn', label: this.i18n.t('bookReport.fieldIsbn') },
      { value: 'other', label: this.i18n.t('bookReport.fieldOther') },
    ];
  }

  get editorInitialForm(): Partial<AdminBookRecord> {
    if (!this.activeEditReport?.suggested) return {};
    const s = this.activeEditReport.suggested;
    return {
      ...(s['title'] ? { title: s['title'] } : {}),
      ...(s['authors'] ? { authors: s['authors'] } : {}),
      ...(s['publisher'] ? { publisher: s['publisher'] } : {}),
      ...(s['published_date'] ? { published_date: s['published_date'] } : {}),
      ...(s['cover'] ? { cover_url: s['cover'] } : {}),
      ...(s['isbn'] ? { isbn13: s['isbn'] } : {}),
    };
  }

  ngOnInit() {
    const user = this.authStore.user();
    const staffRegions: string[] | null = user && !isAdminUser(user) ? (user.managed_regions ?? []) : null;
    const currentReg = this.regionService.region().toUpperCase();
    if (staffRegions) {
      this.regionFilter = staffRegions.includes(currentReg) ? currentReg : (staffRegions[0] ?? '');
    } else {
      this.regionFilter = currentReg;
    }
    this.reload();
  }

  getRegionName(code?: string): string {
    if (!code) return '';
    const reg = this.regionService.regions().find((r) => r.code === code);
    return reg ? reg.localized_name : code;
  }

  fieldLabel(field: string): string {
    const keyMap: Record<string, string> = {
      title: 'bookReport.fieldTitle',
      authors: 'bookReport.fieldAuthors',
      publisher: 'bookReport.fieldPublisher',
      published_date: 'bookReport.fieldPublishedDate',
      cover: 'bookReport.fieldCover',
      isbn: 'bookReport.fieldIsbn',
      other: 'bookReport.fieldOther',
    };
    const key = keyMap[field];
    return key ? this.i18n.t(key) : field;
  }

  getCurrentVal(report: AdminBookReport, field: string): string {
    if (!report.book) return '—';
    const b = report.book as any;
    if (field === 'cover') return b.cover_url || '—';
    if (field === 'isbn') return b.isbn13 || '—';
    return b[field] || '—';
  }

  getSuggestedVal(report: AdminBookReport, field: string): string {
    return report.suggested?.[field] || '—';
  }

  toggleExpand(report: AdminBookReport) {
    this.expandedId = this.expandedId === report.id ? null : report.id;
  }

  onPageChange(page: number) {
    this.page = page;
    this.reload();
  }

  reload() {
    this.loading = true;
    this.loadError = '';
    this.adminService
      .getBookReports({
        status: this.statusFilter || undefined,
        page: this.page,
        region: this.regionFilter || undefined,
        field: this.fieldFilter || undefined,
      })
      .subscribe({
        next: (res) => {
          this.reports = res.results;
          this.total = res.count;
          this.loading = false;
          this.loaded = true;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.loading = false;
          this.cdr.markForCheck();
        },
      });
  }

  applyAndFix(report: AdminBookReport) {
    this.loadingEdit = true;
    this.adminService.getBook(report.book.id).subscribe({
      next: (book) => {
        this.loadingEdit = false;
        this.activeEditReport = report;
        this.activeEditBookId = book.id;
        this.activeEditBookSource = book.source;
        this.activeEditBook = {
          isbn13: book.isbn13 || '',
          title: book.title,
          authors: book.authors || '',
          publisher: book.publisher || '',
          published_date: book.published_date || '',
          cover_url: book.cover_url || '',
          open_reports: book.open_reports,
        };
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingEdit = false;
        this.toast.error(parseAdminError(err, this.i18n, 'admin.errGeneric'));
        this.cdr.markForCheck();
      },
    });
  }

  closeEditor() {
    this.activeEditReport = null;
    this.activeEditBook = null;
    this.activeEditBookId = '';
    this.activeEditBookSource = null;
  }

  onEditorSaved() {
    this.closeEditor();
    this.reload();
  }

  onEditorMerged(_targetId: string) {
    this.closeEditor();
    this.reload();
  }

  markFixed(report: AdminBookReport) {
    this.actingId = report.id;
    this.adminService.actionBookReport(report.id, 'fixed').subscribe({
      next: () => {
        this.actingId = null;
        this.toast.success(this.i18n.t('admin.bookReports.fixedToast'));
        this.reload();
      },
      error: (err) => {
        this.actingId = null;
        this.toast.error(parseAdminError(err, this.i18n, 'admin.errGeneric'));
        this.cdr.markForCheck();
      },
    });
  }

  startDismiss(report: AdminBookReport) {
    this.dismissingReport = report;
    this.dismissNote = '';
  }

  cancelDismiss() {
    this.dismissingReport = null;
    this.dismissNote = '';
  }

  confirmDismiss() {
    if (!this.dismissingReport) return;
    const reportId = this.dismissingReport.id;
    this.actingId = reportId;
    const note = this.dismissNote.trim();
    this.adminService.actionBookReport(reportId, 'dismissed', note || undefined).subscribe({
      next: () => {
        this.actingId = null;
        this.dismissingReport = null;
        this.dismissNote = '';
        this.toast.success(this.i18n.t('admin.bookReports.dismissedToast'));
        this.reload();
      },
      error: (err) => {
        this.actingId = null;
        this.toast.error(parseAdminError(err, this.i18n, 'admin.errGeneric'));
        this.cdr.markForCheck();
      },
    });
  }
}
