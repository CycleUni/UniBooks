import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { forkJoin } from 'rxjs';
import { AccountService, ChatReportItem, ListingReportItem } from '../../core/services/account.service';
import { TPipe } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { DateTimeFormatPipe } from '../../shared/pipes/datetime-format.pipe';

export interface UserReportItem {
  id: string;
  type: 'listing' | 'chat';
  reason: string;
  detail?: string;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
  listing?: {
    id: string;
    title?: string;
    /** The seller deleted the listing; the report keeps its title. */
    deleted?: boolean;
  };
  conversation?: {
    id: string;
    listing_title?: string;
    listing_deleted?: boolean;
  };
}

@Component({
  selector: 'app-account-reports',
  standalone: true,
  imports: [CommonModule, RouterModule, TPipe, UiSkeleton, UiErrorState, UiPagination, UiEmpty, DateTimeFormatPipe],
  template: `
    <h2 class="section-heading">{{ 'acct.tabReports' | t }}</h2>

    <div class="tabs">
      <button class="tab" [class.active]="activeFilter === 'all'" (click)="setFilter('all')">
        {{ 'acct.reportFilterAll' | t }}
      </button>
      <button class="tab" [class.active]="activeFilter === 'listing'" (click)="setFilter('listing')">
        {{ 'acct.reportFilterListing' | t }}
      </button>
      <button class="tab" [class.active]="activeFilter === 'chat'" (click)="setFilter('chat')">
        {{ 'acct.reportFilterChat' | t }}
      </button>
    </div>

    <ui-skeleton *ngIf="isLoading" variant="report" [count]="3"></ui-skeleton>

    <ui-error-state
      *ngIf="!isLoading && loadFailed"
      [message]="'acct.reportsLoadFailed' | t"
      (retry)="loadReports(currentPage)"
    ></ui-error-state>

    <div *ngIf="!isLoading && !loadFailed">
      <ui-empty *ngIf="reports.length === 0" [message]="'acct.noReports' | t"></ui-empty>

      <div class="reports-list" *ngIf="reports.length > 0">
        <div class="report-card" *ngFor="let report of reports">
          <div class="report-header">
            <div class="report-main-info">
              <span class="type-badge" [ngClass]="report.type">
                {{ (report.type === 'listing' ? 'acct.reportTypeListing' : 'acct.reportTypeChat') | t }}
              </span>
              <span class="report-reason">{{ reasonLabel(report) | t }}</span>
              <span class="report-date">{{ report.created_at | dateTimeFormat }}</span>
            </div>
            <span class="status-badge" [ngClass]="report.status">
              {{ ('acct.reportStatus.' + report.status) | t }}
            </span>
          </div>

          <div class="report-body">
            <div class="report-field" *ngIf="report.type === 'listing' && report.listing?.title">
              <span class="field-label">{{ 'acct.reportListing' | t }}:</span>
              <span class="field-value">{{ report.listing?.title }}<span *ngIf="report.listing?.deleted" class="text-muted"> · {{ 'common.listingDeleted' | t }}</span></span>
            </div>
            <div class="report-field" *ngIf="report.type === 'chat' && report.conversation?.listing_title">
              <span class="field-label">{{ 'acct.reportConversation' | t }}:</span>
              <span class="field-value">{{ report.conversation?.listing_title }}<span *ngIf="report.conversation?.listing_deleted" class="text-muted"> · {{ 'common.listingDeleted' | t }}</span></span>
            </div>
            <div class="report-field" *ngIf="report.detail">
              <span class="field-label">{{ 'acct.reportDetail' | t }}:</span>
              <span class="field-value">{{ report.detail }}</span>
            </div>
          </div>
        </div>
      </div>

      <ui-pagination
        *ngIf="totalReports > pageSize"
        [total]="totalReports"
        [pageSize]="pageSize"
        [currentPage]="currentPage"
        (pageChange)="onPageChange($event)"
      ></ui-pagination>
    </div>
  `,
  styles: [`
    .tabs {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--line);
    }
    .tab {
      background: none;
      border: none;
      padding: 8px 16px;
      font-size: var(--text-base);
      cursor: pointer;
      color: var(--muted);
      border-bottom: 2px solid transparent;
      transition: color var(--motion-fast) ease, border-color var(--motion-fast) ease;
    }
    .tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 700;
    }
    .loading-state {
      padding: 32px;
      text-align: center;
      color: var(--muted);
      background: var(--paper-warm);
      border-radius: 8px;
      border: 1px solid var(--line);
    }
    .reports-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 24px;
    }
    .report-card {
      background: var(--surface-card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .report-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .report-main-info {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .type-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: var(--text-xs);
      font-weight: 600;
      line-height: 1.4;
    }
    .type-badge.listing {
      background: var(--paper-warm);
      color: var(--ink);
      border: 1px solid var(--line);
    }
    .type-badge.chat {
      background: var(--info-bg);
      color: var(--info-ink);
      border: 1px solid var(--info-border);
    }
    .report-reason {
      font-weight: 600;
      font-size: var(--text-md);
      color: var(--ink);
    }
    .report-date {
      font-size: var(--text-sm);
      color: var(--muted);
    }
    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: var(--text-xs);
      font-weight: 600;
      text-transform: capitalize;
    }
    .status-badge.open {
      background: var(--warn-bg);
      color: var(--warn-ink);
    }
    .status-badge.actioned {
      background: var(--success-light);
      color: var(--success);
    }
    .status-badge.dismissed {
      background: var(--paper-warm);
      color: var(--muted);
      border: 1px solid var(--line);
    }
    .report-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: var(--text-base);
    }
    .report-field {
      display: flex;
      gap: 8px;
    }
    .field-label {
      color: var(--muted);
      flex-shrink: 0;
    }
    .field-value {
      color: var(--ink);
      word-break: break-word;
    }
  `]
})
export class ReportsComponent implements OnInit {
  private accountService = inject(AccountService);
  private cdr = inject(ChangeDetectorRef);

  activeFilter: 'all' | 'listing' | 'chat' = 'all';
  reports: UserReportItem[] = [];
  // True from the start: the first render must not show "no reports" before
  // the request has had a chance to answer.
  isLoading = true;
  /** The last load failed: an empty list here is unknown, not "none". */
  loadFailed = false;
  totalReports = 0;
  pageSize = 20;
  currentPage = 1;

  ngOnInit() {
    this.loadReports();
  }

  setFilter(filter: 'all' | 'listing' | 'chat') {
    if (this.activeFilter === filter) return;
    this.activeFilter = filter;
    this.currentPage = 1;
    this.loadReports(1);
  }

  loadReports(page = 1) {
    this.isLoading = true;
    this.loadFailed = false;
    this.currentPage = page;

    if (this.activeFilter === 'all') {
      forkJoin({
        // No per-side fallback to an empty page: half the list passed off
        // as all of it is worse than saying the load failed.
        listingRes: this.accountService.getMyListingReports(page),
        chatRes: this.accountService.getMyChatReports(page),
      }).subscribe({
        next: ({ listingRes, chatRes }) => {
          const listingItems: UserReportItem[] = (listingRes.results || []).map(r => ({
            id: r.id,
            type: 'listing',
            reason: r.reason,
            detail: r.detail,
            status: r.status,
            created_at: r.created_at,
            listing: r.listing,
          }));
          const chatItems: UserReportItem[] = (chatRes.results || []).map(r => ({
            id: r.id,
            type: 'chat',
            reason: r.reason,
            detail: r.detail,
            status: r.status,
            created_at: r.created_at,
            conversation: r.conversation,
          }));

          this.reports = [...listingItems, ...chatItems].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
          this.totalReports = (listingRes.count || 0) + (chatRes.count || 0);
          this.isLoading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('Failed to load reports', err);
          this.reports = [];
          this.totalReports = 0;
          this.isLoading = false;
          this.loadFailed = true;
          this.cdr.markForCheck();
        }
      });
    } else if (this.activeFilter === 'listing') {
      this.accountService.getMyListingReports(page).subscribe({
        next: (res) => {
          this.reports = (res.results || []).map(r => ({
            id: r.id,
            type: 'listing',
            reason: r.reason,
            detail: r.detail,
            status: r.status,
            created_at: r.created_at,
            listing: r.listing,
          }));
          this.totalReports = res.count || 0;
          this.isLoading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('Failed to load listing reports', err);
          this.reports = [];
          this.totalReports = 0;
          this.isLoading = false;
          this.loadFailed = true;
          this.cdr.markForCheck();
        }
      });
    } else {
      this.accountService.getMyChatReports(page).subscribe({
        next: (res) => {
          this.reports = (res.results || []).map(r => ({
            id: r.id,
            type: 'chat',
            reason: r.reason,
            detail: r.detail,
            status: r.status,
            created_at: r.created_at,
            conversation: r.conversation,
          }));
          this.totalReports = res.count || 0;
          this.isLoading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('Failed to load chat reports', err);
          this.reports = [];
          this.totalReports = 0;
          this.isLoading = false;
          this.loadFailed = true;
          this.cdr.markForCheck();
        }
      });
    }
  }

  onPageChange(page: number) {
    this.loadReports(page);
  }

  reasonLabel(reasonOrReport: string | UserReportItem, type?: 'listing' | 'chat'): string {
    if (typeof reasonOrReport === 'object' && reasonOrReport !== null) {
      return this.getReasonKey(reasonOrReport.reason, reasonOrReport.type);
    }
    return this.getReasonKey(reasonOrReport, type || 'chat');
  }

  private getReasonKey(reason: string, type: 'listing' | 'chat'): string {
    if (type === 'listing') {
      const map: Record<string, string> = {
        fake: 'moderation.reasonFake',
        scam: 'moderation.reasonScam',
        other: 'moderation.reasonOther',
      };
      return map[reason] || 'moderation.reasonOther';
    } else {
      const map: Record<string, string> = {
        harassment: 'msg.reportReasonHarassment',
        scam: 'msg.reportReasonScam',
        spam: 'msg.reportReasonSpam',
        other: 'msg.reportReasonOther',
      };
      return map[reason] || 'msg.reportReasonOther';
    }
  }
}
