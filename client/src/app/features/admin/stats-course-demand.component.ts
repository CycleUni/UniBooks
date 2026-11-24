import { ChangeDetectorRef, Component, DestroyRef, effect, inject, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { AdminCourseDemand, AdminStatsService } from '../../core/services/admin-stats.service';
import { parseAdminError } from '../../core/admin-error.util';
import { I18nService, TPipe } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { STATS_PAGE_STYLES, StatsFormat } from './stats-widgets';

/**
 * 課程供需: what students asked for ("I am taking this course") against what
 * is for sale at their school. A course with requests and nothing for sale is
 * the gap sellers should be pointed at.
 */
@Component({
  selector: 'app-admin-stats-course-demand',
  standalone: true,
  imports: [CommonModule, TPipe, UiSkeleton, UiErrorState, UiPagination],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navStatsCourses' | t }}</h2>
    </div>
    <p class="scope-note">{{ 'admin.stats.courseDemandNote' | t }}</p>

    <ui-skeleton *ngIf="!data && loading" variant="spinner"></ui-skeleton>
    <ui-error-state *ngIf="!data && !loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>

    <ng-container *ngIf="data as d">
      <div class="kpi-grid">
        <div class="kpi"><span class="kpi-label">{{ 'admin.stats.courseDemandRequests' | t }}</span><span class="kpi-value">{{ fmt.int(d.summary.requests) }}</span></div>
        <div class="kpi"><span class="kpi-label">{{ 'admin.stats.courseDemandStudents' | t }}</span><span class="kpi-value">{{ fmt.int(d.summary.students) }}</span></div>
        <div class="kpi"><span class="kpi-label">{{ 'admin.stats.courseDemandCourses' | t }}</span><span class="kpi-value">{{ fmt.int(d.summary.courses) }}</span></div>
        <div class="kpi"><span class="kpi-label">{{ 'admin.stats.courseDemandUnmet' | t }}</span><span class="kpi-value warn">{{ fmt.int(d.summary.unmet_courses) }}</span></div>
      </div>

      <div class="table-container" [class.stale]="loading" *ngIf="d.results.length > 0">
        <table class="admin-table">
          <thead>
            <tr>
              <th>{{ 'admin.stats.bySchool' | t }}</th>
              <th>{{ 'admin.stats.byCourse' | t }}</th>
              <th class="num">{{ 'admin.stats.courseDemandRequests' | t }}</th>
              <th class="num">{{ 'admin.stats.activeListings' | t }}</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let r of d.results">
              <td>{{ r.school }}</td>
              <td>{{ r.course }}</td>
              <td class="num">{{ fmt.int(r.request_count) }}</td>
              <td class="num" [class.unmet]="r.active_listings === 0">{{ fmt.int(r.active_listings) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="card-note" *ngIf="d.results.length === 0">{{ 'admin.stats.courseDemandEmpty' | t }}</p>
      <ui-pagination *ngIf="d.count > pageSize" [currentPage]="page" [total]="d.count" [pageSize]="pageSize" (pageChange)="onPageChange($event)"></ui-pagination>
    </ng-container>
  `,
  styles: [STATS_PAGE_STYLES, `.unmet { color: var(--danger); font-weight: 600; }`],
})
export class AdminStatsCourseDemandComponent {
  private stats = inject(AdminStatsService);
  private i18n = inject(I18nService);
  private regionService = inject(RegionService);
  private cdr = inject(ChangeDetectorRef);

  readonly fmt = new StatsFormat(this.i18n);
  page = 1;
  pageSize = 20;
  data: AdminCourseDemand | null = null;
  loading = true;
  loadError = '';
  private sub?: Subscription;

  constructor() {
    effect(() => {
      this.regionService.region();
      untracked(() => {
        this.page = 1;
        this.load();
      });
    });
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
  }

  onPageChange(page: number) {
    this.page = page;
    this.load();
  }

  load() {
    this.sub?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.sub = this.stats.getCourseDemand({ region: this.regionService.region(), page: this.page, page_size: this.pageSize }).subscribe({
      next: (res) => {
        this.data = res;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.data = null;
        this.loading = false;
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      },
    });
  }
}
