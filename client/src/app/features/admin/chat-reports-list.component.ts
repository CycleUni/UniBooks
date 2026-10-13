import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminChatReport } from '../../core/services/admin.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { parseAdminError } from '../../core/admin-error.util';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { AuthStore } from '../../core/auth.store';
import { chatRoomMessagesUrl } from '../../core/chat-urls';
import { RegionService } from '../../core/region.service';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';

@Component({
  selector: 'app-admin-chat-reports-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiButton, UiDropdown, UiPagination, AdminBulkBarComponent, AdminPickCellComponent],
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

    <table class="admin-table admin-table-clickable" *ngIf="!loading && !loadError">
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
          <th>{{ 'admin.colReported' | t }}</th>
          <th>{{ 'admin.colConversation' | t }}</th>
          <th>{{ 'admin.colReason' | t }}</th>
          <th>{{ 'admin.colStatus' | t }}</th>
          <th *ngIf="statusFilter === 'open'"></th>
        </tr>
      </thead>
      <tbody>
        <ng-container *ngFor="let report of reports">
          <tr class="report-row" (click)="toggleExpand(report)" [class.picked]="bulk.selection.has(report.id)">
            <td *ngIf="statusFilter === 'open'" adminPick
              [checked]="bulk.selection.has(report.id)"
              [disabled]="bulk.busy || report.status !== 'open'"
              [label]="'admin.bulk.selectRow' | t: { name: report.listing_title || report.id }"
              (toggle)="bulk.selection.toggle(report.id)"></td>
            <td>{{ getRegionName(report.region) }}</td>
            <td>{{ report.reporter_email }}</td>
            <td>{{ report.reported_party_email }}</td>
            <td>{{ report.listing_title }} <span class="conv-id">({{ report.conversation_id }})</span></td>
            <td>{{ reasonLabel(report.reason) | t }}</td>
            <td><span class="admin-status-badge" [class.warn]="report.status === 'open'">{{ ('admin.chatReportStatus.' + report.status) | t }}</span></td>
            <td *ngIf="report.status === 'open'" class="actions-cell">
              <ui-button (onClick)="action(report, 'actioned')" [disabled]="actingId === report.id">{{ 'admin.reportActionFlag' | t }}</ui-button>
              <ui-button variant="ghost" (onClick)="action(report, 'dismissed')" [disabled]="actingId === report.id">{{ 'admin.reportActionDismiss' | t }}</ui-button>
            </td>
          </tr>
          <tr class="detail-row" *ngIf="expandedId === report.id">
            <td colspan="8">
              <div class="detail-content">
                <div *ngIf="report.detail" class="report-detail">
                  <strong>{{ 'admin.reportDetailLabel' | t }}</strong> {{ report.detail }}
                </div>
                <ui-button variant="ghost" (onClick)="loadMessages(report.id)" [disabled]="loadingMessages">
                  {{ (loadingMessages ? 'common.loading' : 'admin.viewMessages') | t }}
                </ui-button>
                <ui-skeleton *ngIf="loadingMessages" variant="row" [count]="3"></ui-skeleton>
                <ui-error-state *ngIf="!loadingMessages && messagesError" [message]="messagesError" (retry)="loadMessages(report.id)"></ui-error-state>
                <div *ngIf="messages?.length" class="messages-preview">
                  <div *ngFor="let msg of messages" class="msg-line">
                    <span class="msg-user">[{{ msg.user_id }}]:</span> {{ msg.content }}
                  </div>
                </div>
                <p *ngIf="messages && messages.length === 0" class="empty-note">{{ 'common.noData' | t }}</p>
              </div>
            </td>
          </tr>
        </ng-container>
        <!-- Stays noMatches unconditionally: statusOptions has no "all"
             entry, so this table is always scoped to one status and an empty
             result always means "none with this status", never "no reports". -->
        <tr *ngIf="reports.length === 0">
          <td colspan="8" class="empty-note">{{ 'common.noMatches' | t }}</td>
        </tr>
      </tbody>
    </table>

    <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
  `,
  styles: [`
    .actions-cell { display: flex; gap: 8px; }
    .conv-id { font-size: var(--text-xs); color: var(--muted); }
    .report-row { cursor: pointer; }
    .report-row:hover { background: var(--paper-warm); }
    .detail-content { padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
    .report-detail { font-size: var(--text-base); color: var(--muted); }
    .messages-preview { max-height: 300px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
    .msg-line { font-size: var(--text-sm); color: var(--ink); padding: 4px 0; border-bottom: 1px solid var(--line); }
    .msg-line:last-child { border-bottom: none; }
    .msg-user { font-weight: 600; color: var(--accent); }
  `]
})
export class AdminChatReportsListComponent implements OnInit {
  private adminService = inject(AdminService);
  private http = inject(HttpClient);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);

  reports: AdminChatReport[] = [];
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
  expandedId: string | null = null;
  loadingMessages = false;
  /** Why the expanded report's messages failed to load; shown with a retry. */
  messagesError = '';
  messages: any[] | null = null;

  getRegionName(code?: string): string {
    if (!code) return '';
    const reg = this.regionService.regions().find(r => r.code === code);
    return reg ? reg.localized_name : code;
  }

  get statusOptions() {
    return [
      { value: 'open', label: this.i18n.t('admin.chatReportStatus.open') },
      { value: 'actioned', label: this.i18n.t('admin.chatReportStatus.actioned') },
      { value: 'dismissed', label: this.i18n.t('admin.chatReportStatus.dismissed') },
    ];
  }

  reasonLabel(reason: string): string {
    switch (reason) {
      case 'harassment': return 'admin.reportReasonHarassment';
      case 'scam': return 'admin.reportReasonScam';
      case 'spam': return 'admin.reportReasonSpam';
      default: return 'admin.reportReasonOther';
    }
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
    this.adminService.getChatReports(this.statusFilter, this.page, this.regionService.region().toUpperCase()).subscribe({
      next: (res) => {
        this.reports = res.results;
        this.total = res.count;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadError = parseAdminError(err, this.i18n, 'admin.errGeneric');
        this.loading = false;
        this.cdr.markForCheck();
      }
    });
  }

  bulkAction(status: 'actioned' | 'dismissed') {
    const n = this.bulk.selection.size;
    this.bulk.run((id) => this.adminService.actionChatReport(id, status), {
      confirm: this.i18n.t(status === 'actioned' ? 'admin.bulk.confirmHandleChatReports' : 'admin.bulk.confirmDismissReports', { n }),
      confirmLabel: this.i18n.t(status === 'actioned' ? 'admin.bulk.handle' : 'admin.reportActionDismiss'),
    });
  }

  action(report: AdminChatReport, status: 'actioned' | 'dismissed') {
    this.actingId = report.id;
    this.adminService.actionChatReport(report.id, status).subscribe({
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

  toggleExpand(report: AdminChatReport) {
    this.expandedId = this.expandedId === report.id ? null : report.id;
    this.messages = null;
    this.messagesError = '';
    // A request still in flight belongs to the row just left; loadMessages
    // drops its answer, so it must not keep this row's button disabled.
    this.loadingMessages = false;
    this.cdr.markForCheck();
  }

  loadMessages(reportId: string) {
    this.loadingMessages = true;
    this.messagesError = '';
    this.messages = null;
    // Only answers for the row still expanded may land: a late one for a row
    // since collapsed or switched away from would show under the wrong report.
    const current = () => this.expandedId === reportId;
    const fail = (err: unknown) => {
      if (!current()) return;
      this.messagesError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
      this.loadingMessages = false;
      this.cdr.markForCheck();
    };
    this.adminService.getChatReportToken(reportId).subscribe({
      next: ({ token, room_id }) => {
        if (!current()) return;
        const url = chatRoomMessagesUrl(room_id);
        this.http.get<any[]>(url, { headers: { Authorization: `Bearer ${token}`, 'ngsw-bypass': 'true' } }).subscribe({
          next: (msgs) => {
            if (!current()) return;
            this.messages = msgs;
            this.loadingMessages = false;
            this.cdr.markForCheck();
          },
          error: fail,
        });
      },
      error: fail,
    });
  }
}