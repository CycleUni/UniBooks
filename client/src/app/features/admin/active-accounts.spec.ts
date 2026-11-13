import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { AdminStatsDashboardComponent } from './stats-dashboard.component';
import { AdminStatsGrowthComponent } from './stats-growth.component';
import { AdminStatsService, ActiveUsersResult } from '../../core/services/admin-stats.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

describe('Admin Active Accounts & MAU widgets (3 states)', () => {
  const fakeI18n = {
    t: (k: string) => k,
    tOrNull: (k: string) => k,
    lang: () => 'zh-TW',
  };

  const sampleActiveUsers: ActiveUsersResult = {
    available: true,
    region: 'TW',
    days: 30,
    today_dau: 42,
    active_7d: 180,
    active_30d: 520,
    stickiness: 0.0808,
    dau_series: [
      { date: '2026-11-13', dau: 38 },
      { date: '2026-11-14', dau: 42 },
    ],
    mau_series: [
      { month: '2026-09', mau: 400 },
      { month: '2026-10', mau: 480 },
      { month: '2026-11', mau: 520 },
    ],
  };

  describe('AdminStatsDashboardComponent (Overview active accounts block)', () => {
    let fixture: ComponentFixture<AdminStatsDashboardComponent>;
    let component: AdminStatsDashboardComponent;
    let activeUsersSubject: Subject<ActiveUsersResult>;

    beforeEach(async () => {
      activeUsersSubject = new Subject<ActiveUsersResult>();
      const statsMock = {
        getOverview: vi.fn(() => of({
          region: 'TW',
          currency: 'TWD',
          days: 30,
          since: null,
          users: { total: 100, new: 10, active_sellers: 5, active_buyers: 8 },
          listings: { new: 10, by_status: { active: 10, reserved: 0, sold: 0, removed: 0 }, avg_price: 200 },
          orders: {
            new: 5,
            by_status: { pending: 1, accepted: 1, handed_over: 1, completed: 2, cancelled: 0 },
            completion_rate: 0.4,
            cancel_rate: 0,
            gmv: 1000,
            avg_order_value: 200,
            avg_days_to_complete: 2.5,
            cancel_reasons: [],
          },
          engagement: { conversations: 15 },
          requests: { total: 0, new: 0, requested_books: 0, unlisted_books: 0 },
          moderation: { open_listing_reports: 0, open_chat_reports: 0, new_listing_reports: 0, new_chat_reports: 0, report_reasons: [] },
          reviews: { count: 3, avg_rating: 4.5, no_show_count: 0 },
          ads: { active: 0, views: 0, clicks: 0, ctr: null },
          top_schools: [],
        })),
        getTimeseries: vi.fn(() => of({
          region: 'TW',
          currency: 'TWD',
          days: 30,
          unit: 'day',
          series: [],
        })),
        getActiveUsers: vi.fn(() => activeUsersSubject.asObservable()),
      };

      await TestBed.configureTestingModule({
        imports: [HttpClientTestingModule, AdminStatsDashboardComponent],
        providers: [
          provideRouter([]),
          { provide: I18nService, useValue: fakeI18n },
          { provide: AdminStatsService, useValue: statsMock },
          {
            provide: ActivatedRoute,
            useValue: {
              snapshot: { queryParamMap: convertToParamMap({ days: '30' }) },
            },
          },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(AdminStatsDashboardComponent);
      component = fixture.componentInstance;
    });

    it('State 1: shows loading skeleton while active users query is in-flight', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const card = el.querySelector('.active-users-card');
      expect(card).not.toBeNull();
      expect(card?.querySelector('ui-skeleton')).not.toBeNull();
      expect(card?.querySelector('.unavailable-box')).toBeNull();
      expect(card?.querySelector('.active-users-content')).toBeNull();
    });

    it('State 2: shows unavailable state when Analytics Engine is not configured', () => {
      fixture.detectChanges();
      activeUsersSubject.next({ available: false });
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const card = el.querySelector('.active-users-card');
      expect(card?.querySelector('ui-skeleton')).toBeNull();
      const unavail = card?.querySelector('.unavailable-box');
      expect(unavail).not.toBeNull();
      expect(unavail?.textContent).toContain('admin.stats.activityUnavailable');
      expect(card?.querySelector('.active-users-content')).toBeNull();
    });

    it('State 3: shows active account figures, DAU chart, and footnote when data is available', () => {
      fixture.detectChanges();
      activeUsersSubject.next(sampleActiveUsers);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const card = el.querySelector('.active-users-card');
      expect(card?.querySelector('ui-skeleton')).toBeNull();
      expect(card?.querySelector('.unavailable-box')).toBeNull();

      const content = card?.querySelector('.active-users-content');
      expect(content).not.toBeNull();
      expect(content?.textContent).toContain('42'); // today_dau
      expect(content?.textContent).toContain('180'); // active_7d
      expect(content?.textContent).toContain('520'); // active_30d
      expect(content?.querySelector('admin-dau-chart')).not.toBeNull();
      expect(content?.textContent).toContain('admin.stats.activityFootnote');
    });
  });

  describe('AdminStatsGrowthComponent (Growth & retention MAU block)', () => {
    let fixture: ComponentFixture<AdminStatsGrowthComponent>;
    let component: AdminStatsGrowthComponent;
    let activeUsersSubject: Subject<ActiveUsersResult>;

    beforeEach(async () => {
      activeUsersSubject = new Subject<ActiveUsersResult>();
      const statsMock = {
        getGrowth: vi.fn(() => of({
          region: 'TW',
          days: 30,
          since: null,
          sell_through: { listings: 10, sold: 4, rate: 0.4 },
          speed: {
            listing_to_first_chat: { count: 3, avg_days: 1.2, median_days: 1.0 },
            listing_to_first_order: { count: 3, avg_days: 2.1, median_days: 2.0 },
            listing_to_sale: { count: 3, avg_days: 3.5, median_days: 3.0 },
            order_to_completion: { count: 3, avg_days: 1.5, median_days: 1.0 },
          },
          users: { buyers: 5, sellers: 4, both: 2, overlap_rate: 0.25, repeat_buyers: 1, repeat_rate: 0.2 },
          chat_to_order: { chats: 6, ordered: 3, completed: 3, order_rate: 0.5, completion_rate: 0.5, undated: 0 },
          requests: { requests: 0, notified: 0, ordered: 0, bought: 0, order_rate: null },
        })),
        getRetention: vi.fn(() => of({
          region: 'TW',
          role: 'all',
          terms: [],
          cohorts: [],
        })),
        getActiveUsers: vi.fn(() => activeUsersSubject.asObservable()),
      };

      await TestBed.configureTestingModule({
        imports: [HttpClientTestingModule, AdminStatsGrowthComponent],
        providers: [
          provideRouter([]),
          { provide: I18nService, useValue: fakeI18n },
          { provide: AdminStatsService, useValue: statsMock },
          {
            provide: ActivatedRoute,
            useValue: {
              snapshot: { queryParamMap: convertToParamMap({ days: '30' }) },
            },
          },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(AdminStatsGrowthComponent);
      component = fixture.componentInstance;
    });

    it('State 1: shows loading skeleton for MAU block', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(component.loadingActiveUsers).toBe(true);
      const mauCard = Array.from(el.querySelectorAll('.card')).find((c) =>
        c.querySelector('h3')?.textContent?.includes('admin.stats.monthlyMau'),
      );
      expect(mauCard).not.toBeNull();
      expect(mauCard?.querySelector('ui-skeleton')).not.toBeNull();
      expect(mauCard?.querySelector('.unavailable-box')).toBeNull();
      expect(mauCard?.querySelector('.mau-content')).toBeNull();
    });

    it('State 2: shows unavailable state for MAU block', () => {
      fixture.detectChanges();
      activeUsersSubject.next({ available: false });
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const mauCard = Array.from(el.querySelectorAll('.card')).find((c) =>
        c.querySelector('h3')?.textContent?.includes('admin.stats.monthlyMau'),
      );
      expect(mauCard?.querySelector('ui-skeleton')).toBeNull();
      const unavail = mauCard?.querySelector('.unavailable-box');
      expect(unavail).not.toBeNull();
      expect(unavail?.textContent).toContain('admin.stats.activityUnavailable');
      expect(mauCard?.querySelector('.mau-content')).toBeNull();
    });

    it('State 3: shows MAU chart and footnote when data is available', () => {
      fixture.detectChanges();
      activeUsersSubject.next(sampleActiveUsers);
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      const mauCard = Array.from(el.querySelectorAll('.card')).find((c) =>
        c.querySelector('h3')?.textContent?.includes('admin.stats.monthlyMau'),
      );
      expect(mauCard?.querySelector('ui-skeleton')).toBeNull();
      expect(mauCard?.querySelector('.unavailable-box')).toBeNull();

      const content = mauCard?.querySelector('.mau-content');
      expect(content).not.toBeNull();
      expect(content?.querySelector('admin-mau-chart')).not.toBeNull();
      expect(content?.textContent).toContain('admin.stats.activityFootnote');
    });
  });
});
