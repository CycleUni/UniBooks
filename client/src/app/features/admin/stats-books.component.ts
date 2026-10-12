import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { StatsDays } from '../../core/services/admin-stats.service';
import { TPipe } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AdminBookRankingComponent } from './book-ranking.component';
import { AdminRequestRankingComponent } from './request-ranking.component';
import { AdminStatsPeriodComponent, STATS_PAGE_STYLES, StatsPeriodMemory } from './stats-widgets';

/** 書本統計: the transaction ranking and, apart from it, the request ranking. */
@Component({
  selector: 'app-admin-stats-books',
  standalone: true,
  imports: [CommonModule, TPipe, AdminStatsPeriodComponent, AdminBookRankingComponent, AdminRequestRankingComponent],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.stats.titleBooks' | t }}</h2>
      <admin-stats-period [days]="days" (daysChange)="onDaysChange($event)"></admin-stats-period>
    </div>
    <p class="scope-note">{{ 'admin.stats.scopeNoteShort' | t: { region: regionName() } }}</p>

    <admin-book-ranking [region]="region()" [days]="days"></admin-book-ranking>
    <admin-request-ranking [region]="region()" [days]="days"></admin-request-ranking>
  `,
  styles: [STATS_PAGE_STYLES],
})
export class AdminStatsBooksComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionService = inject(RegionService);
  private period = inject(StatsPeriodMemory);

  days: StatsDays = this.period.resolve(this.route.snapshot.queryParamMap.get('days'));

  region(): string {
    return this.regionService.region().toUpperCase();
  }

  regionName(): string {
    return this.regionService.currentRegionObj()?.localized_name ?? this.region();
  }

  /** One navigation for the period and every list's page, which starts over. */
  onDaysChange(days: StatsDays) {
    this.days = days;
    this.period.days.set(days);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { days, page: null, rpage: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
