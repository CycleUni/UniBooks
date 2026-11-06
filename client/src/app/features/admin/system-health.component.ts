import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import {
  AdminService,
  HealthCheck,
  HealthStatus,
  SystemHealth,
} from '../../core/services/admin.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';

const TIME_FORMAT = 'yyyy/MM/dd HH:mm:ss';

/**
 * /admin/system (superusers): the platform's own checks and one live call to
 * each catalogue source (Google Books, Open Library, the ISBNnet resolver
 * Worker). Loaded on open and on demand only, never polled; the server caches
 * the external results (5 minutes while all answer, 30 seconds otherwise).
 */
@Component({
  selector: 'app-admin-system-health',
  standalone: true,
  imports: [CommonModule, TPipe, UiButton, UiErrorState, UiSkeleton],
  providers: [DatePipe],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navSystemHealth' | t }}</h2>
      <ui-button variant="outline" (onClick)="load()" [disabled]="loading()">
        {{ (loading() ? 'admin.health.checking' : 'admin.health.refresh') | t }}
      </ui-button>
    </div>

    <ui-skeleton *ngIf="!data() && loading()" variant="table" [count]="6"></ui-skeleton>
    <ui-error-state
      *ngIf="loadFailed()"
      [message]="'admin.errLoadFailed' | t"
      (retry)="load()"
    ></ui-error-state>

    <ng-container *ngIf="data() as d">
      <div
        class="health-summary"
        [class]="'health-summary is-' + d.status"
        role="status"
        aria-live="polite"
      >
        <span class="dot" aria-hidden="true"></span>
        <strong>{{ 'admin.health.overall.' + d.status | t }}</strong>
        <span class="checked-at">{{
          'admin.health.checkedAt' | t: { time: (d.checked_at | date: timeFormat) ?? '' }
        }}</span>
      </div>

      <section *ngFor="let group of groups" class="health-group">
        <h3>{{ group.title | t }}</h3>
        <ng-container *ngIf="group.key === 'external'">
          <p class="health-note">
            {{
              'admin.health.externalCheckedAt'
                | t: { time: (d.external_checked_at | date: timeFormat) ?? '' }
            }}
            <span *ngIf="d.external_cached" class="admin-status-badge">{{
              'admin.health.cached' | t
            }}</span>
          </p>
          <p class="health-note">{{ 'admin.health.externalNote' | t }}</p>
        </ng-container>
        <div class="table-container">
          <table class="admin-table">
            <thead>
              <tr>
                <th>{{ 'admin.health.colService' | t }}</th>
                <th>{{ 'admin.health.colStatus' | t }}</th>
                <th *ngIf="group.key === 'external'">{{ 'admin.health.colLatency' | t }}</th>
                <th>{{ 'admin.health.colDetail' | t }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let c of checksIn(d, group.key)">
                <td>{{ 'admin.health.name.' + c.name | t }}</td>
                <td>
                  <span class="admin-status-badge" [ngClass]="badgeClass(c.status)">{{
                    'admin.health.status.' + c.status | t
                  }}</span>
                </td>
                <td *ngIf="group.key === 'external'" class="nowrap">
                  {{ c.latency_ms != null ? c.latency_ms + ' ms' : '—' }}
                </td>
                <td>
                  <div *ngIf="detailText(c) as text">{{ text }}</div>
                  <div *ngIf="c.skipping_until" class="health-skip">
                    {{
                      'admin.health.skippingUntil'
                        | t: { time: (c.skipping_until | date: timeFormat) ?? '' }
                    }}
                  </div>
                  <span *ngIf="!detailText(c) && !c.skipping_until" class="muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </ng-container>
  `,
  styles: [
    `
      .health-summary {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        margin-bottom: var(--space-5);
        border: 1px solid var(--line);
        border-radius: var(--radius-md);
        background: var(--surface-raised);
      }
      .health-summary .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--success);
      }
      .health-summary.is-degraded .dot {
        background: var(--warn-ink);
      }
      .health-summary.is-error .dot {
        background: var(--danger);
      }
      .checked-at {
        margin-left: auto;
        font-size: var(--text-sm);
        color: var(--muted);
      }
      .health-group {
        margin-bottom: var(--space-5);
      }
      .health-group h3 {
        font-size: var(--text-lg);
        margin: 0 0 var(--space-2);
      }
      .health-note {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        color: var(--muted);
      }
      .health-skip {
        font-size: var(--text-sm);
        color: var(--muted);
      }
      .admin-status-badge.down {
        background: var(--danger-light);
        color: var(--danger);
      }
      .nowrap {
        white-space: nowrap;
      }
      .muted {
        color: var(--muted);
      }
    `,
  ],
})
export class AdminSystemHealthComponent implements OnInit {
  private admin = inject(AdminService);
  private i18n = inject(I18nService);

  readonly timeFormat = TIME_FORMAT;
  readonly groups = [
    { key: 'core', title: 'admin.health.groupCore' },
    { key: 'external', title: 'admin.health.groupExternal' },
  ] as const;

  readonly data = signal<SystemHealth | null>(null);
  readonly loading = signal(false);
  readonly loadFailed = signal(false);

  ngOnInit() {
    this.load();
  }

  load() {
    if (this.loading()) return;
    this.loading.set(true);
    this.loadFailed.set(false);
    this.admin.getSystemHealth().subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => {
        // Keep the last result on screen; the error state says this check failed.
        this.loadFailed.set(true);
        this.loading.set(false);
      },
    });
  }

  checksIn(d: SystemHealth, group: HealthCheck['group']): HealthCheck[] {
    return d.checks.filter((c) => c.group === group);
  }

  badgeClass(status: HealthStatus): string {
    return status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : 'down';
  }

  /** The server's detail code as a sentence; null when there is none or no locale knows it. */
  detailText(c: HealthCheck): string | null {
    const detail = c.detail;
    if (!detail) return null;
    const http = /^http_(\d+)$/.exec(detail);
    if (http) return this.i18n.t('admin.health.detail.http', { code: http[1] });
    const unapplied = /^unapplied_(\d+)$/.exec(detail);
    if (unapplied) return this.i18n.t('admin.health.detail.unapplied', { count: unapplied[1] });
    return this.i18n.tOrNull(`admin.health.detail.${detail}`);
  }
}
