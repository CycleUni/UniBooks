import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { UiButton } from '../../shared/ui/button.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiBookTile } from '../../shared/ui/book-tile.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AccountService } from '../../core/services/account.service';
import { CourseService } from '../../core/services/course.service';
import { RegionLinkService } from '../../core/region-link.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { bookQueryParams } from '../../core/book-preview';
import { parseApiError } from '../../core/api-error.util';
import { RequestExpiryComponent, RequestDuration } from './request-expiry.component';
import type { CourseWantDto, SubscriptionDto } from '../../../../../server/src/api-types';


@Component({
  selector: 'app-account-subscriptions',
  standalone: true,
  imports: [CommonModule, RouterLink, UiButton, UiEmpty, UiBookTile, UiSkeleton, UiErrorState, TPipe, RequestExpiryComponent],
  template: `
    <div class="section-head-row">
      <h2 class="section-heading">{{ 'acct.tabSubs' | t }}</h2>
      <ui-button variant="ghost" *ngIf="!loading && mySubscriptions.length > 0" (onClick)="cancelAllSubscriptions()">{{ 'acct.cancelAllSubs' | t }}</ui-button>
    </div>

    <!-- Until the first response lands the list is unknown, not empty:
         showing "no subscriptions" and then swapping in the grid read as
         the page contradicting itself. -->
    <ui-skeleton *ngIf="loading" variant="discover-grid" [count]="4"></ui-skeleton>

    <ui-error-state
      *ngIf="!loading && loadFailed"
      [message]="'common.error' | t"
      (retry)="loadSubscriptions()"
    ></ui-error-state>

    <div class="discover-grid" *ngIf="!loading && !loadFailed && mySubscriptions.length > 0">
      <ui-book-tile
        *ngFor="let sub of mySubscriptions"
        [title]="sub.bookTitle"
        [isbn]="sub.isbn"
        [coverUrl]="sub.bookCoverUrl"
        mode="waitlist"
        [waitingCount]="sub.newListingsCount"
        [link]="['/book']"
        [linkParams]="bookParams(sub)"
      >
        <div tile-actions class="tile-actions-inner">
          <span class="sub-status" [class.available]="sub.newListingsCount > 0">
            <ng-container *ngIf="sub.newListingsCount === 0">{{ 'acct.noOneListed' | t }}</ng-container>
            <ng-container *ngIf="sub.newListingsCount > 0">{{ 'acct.newListings' | t:{n: sub.newListingsCount} }}</ng-container>
          </span>
          <app-request-expiry [expiresAt]="sub.expires_at" (durationChange)="setSubscriptionDuration(sub, $event)"></app-request-expiry>
          <ui-button *ngIf="sub.newListingsCount > 0" (onClick)="$event.stopPropagation(); viewBook(sub)">{{ 'acct.viewNow' | t }}</ui-button>
          <ui-button variant="ghost" *ngIf="sub.newListingsCount === 0" (onClick)="$event.stopPropagation(); cancelSubscription(sub.id)">{{ 'acct.cancelNotify' | t }}</ui-button>
        </div>
      </ui-book-tile>
    </div>

    <ui-empty *ngIf="!loading && !loadFailed && mySubscriptions.length === 0 && myCourses.length === 0" [message]="'acct.noSubs' | t"></ui-empty>

    <!-- Courses the student asked to hear about; the section appears with the first request. -->
    <ng-container *ngIf="myCourses.length > 0">
      <h2 class="section-heading course-heading">{{ 'acct.myCourses' | t }}</h2>
      <ul class="course-requests">
        <li *ngFor="let w of myCourses">
          <a class="course-link" [routerLink]="regionLink.path(['/course/detail'])" [queryParams]="{school: w.school, name: w.name}">{{ w.name }}</a>
          <app-request-expiry [expiresAt]="w.expires_at" (durationChange)="setCourseDuration(w, $event)"></app-request-expiry>
          <ui-button variant="ghost" (onClick)="cancelCourse(w)">{{ 'acct.cancelCourse' | t }}</ui-button>
        </li>
      </ul>
    </ng-container>
  `,
  styles: [`
    /* .discover-grid is declared once, globally. A copy here would win on
       specificity — view encapsulation adds an attribute selector — and this
       one silently did, with a 160px track against the global 180px. */
    .tile-actions-inner {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      margin-top: 8px;
    }
    .sub-status {
      font-size: var(--text-sm);
      color: var(--muted);
    }
    .sub-status.available { color: var(--flag); font-weight: 500; }
    .course-heading { margin-top: var(--space-5); }
    .course-requests { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .course-requests li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
    .course-link { flex: 1 1 8rem; color: var(--ink); font-weight: 500; text-decoration: none; }
    .course-link:hover { color: var(--accent); }
  `]
})
export class SubscriptionsComponent implements OnInit {
  mySubscriptions: SubscriptionDto[] = [];
  loading = true;
  loadFailed = false;

  private accountService = inject(AccountService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  readonly regionLink = inject(RegionLinkService);
  private courseService = inject(CourseService);
  myCourses: CourseWantDto[] = [];
  readonly i18n = inject(I18nService);

  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  ngOnInit() {
    this.loadSubscriptions();
    this.loadCourses();
  }

  private loadCourses() {
    // A secondary list: a failed request just leaves it out.
    this.courseService.myWants().subscribe({
      next: (rows) => {
        this.myCourses = rows;
        this.cdr.markForCheck();
      },
      error: () => {},
    });
  }

  /** Replace one row with the server's answer; a new array, since the page is OnPush. */
  private replace<T extends { id: string }>(rows: T[], row: T): T[] {
    return rows.map((r) => (r.id === row.id ? row : r));
  }

  setSubscriptionDuration(sub: SubscriptionDto, duration: RequestDuration) {
    this.accountService.setSubscriptionDuration(sub.id, duration).subscribe({
      next: (row) => {
        this.mySubscriptions = this.replace(this.mySubscriptions, { ...sub, expires_at: row.expires_at });
        this.cdr.markForCheck();
      },
      error: (err) => this.toast.error(parseApiError(err, this.i18n, 'acct.expiryFailed')),
    });
  }

  setCourseDuration(want: CourseWantDto, duration: RequestDuration) {
    this.courseService.setDuration(want.id, duration).subscribe({
      next: (row) => {
        this.myCourses = this.replace(this.myCourses, row);
        this.cdr.markForCheck();
      },
      error: (err) => this.toast.error(parseApiError(err, this.i18n, 'acct.expiryFailed')),
    });
  }

  async cancelCourse(want: CourseWantDto) {
    if (!(await this.confirms.askDanger(this.i18n.t('acct.confirmCancelCourse')))) return;
    this.courseService.unwant(want.id).pipe(this.toast.working(this.i18n.t('common.cancelling'))).subscribe({
      next: () => this.loadCourses(),
      error: (err) => {
        console.error('Failed to remove course request', err);
        this.toast.error(this.i18n.t('acct.unsubscribeFailed'));
      }
    });
  }

  /**
   * `quiet` refreshes after an unsubscribe without swapping the grid for a
   * skeleton: the list is already on screen and only shrinks.
   */
  loadSubscriptions(quiet = false) {
    if (!quiet) this.loading = true;
    this.loadFailed = false;
    this.accountService.getMySubscriptions().subscribe({
      next: (subs) => {
        this.mySubscriptions = subs;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load subscriptions', err);
        this.loading = false;
        // Keep what is already listed; only an empty first load is a failure.
        this.loadFailed = this.mySubscriptions.length === 0;
        this.cdr.markForCheck();
      }
    });
  }

  async cancelSubscription(id: string) {
    if (await this.confirms.askDanger(this.i18n.t('acct.confirmCancelSub'))) {
      this.accountService.unsubscribe(id).pipe(this.toast.working(this.i18n.t('common.cancelling'))).subscribe({
        next: () => this.loadSubscriptions(true),
        error: (err) => {
          console.error('Failed to unsubscribe', err);
          this.toast.error(this.i18n.t('acct.unsubscribeFailed'));
        }
      });
    }
  }

  async cancelAllSubscriptions() {
    if (await this.confirms.askDanger(this.i18n.t('acct.confirmCancelAllSubs'))) {
      this.accountService.unsubscribeAll().pipe(this.toast.working(this.i18n.t('common.cancelling'))).subscribe({
        next: () => this.loadSubscriptions(true),
        error: (err) => {
          console.error('Failed to unsubscribe all', err);
          this.toast.error(this.i18n.t('acct.unsubscribeFailed'));
        }
      });
    }
  }

  /** The book's page, by ISBN or, for a book without one, by its id. */
  bookParams(sub: Pick<SubscriptionDto, 'isbn' | 'book'>): Record<string, string | number> {
    return bookQueryParams({ isbn: sub.isbn, id: sub.book });
  }

  viewBook(sub: Pick<SubscriptionDto, 'isbn' | 'book'>) {
    this.router.navigate(this.regionLink.path(['/book']), { queryParams: this.bookParams(sub) });
  }
}
