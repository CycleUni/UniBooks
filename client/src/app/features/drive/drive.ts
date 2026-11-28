import { ChangeDetectorRef, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { of } from 'rxjs';
import { PhonePager } from '../../core/phone-pager';
import { injectIsPhone } from '../../core/viewport';
import { I18nService, TPipe } from '../../core/i18n.service';
import {
  DriveService,
  type DriveClaim,
  type DrivePage,
  type DriveTitle,
} from '../../core/services/drive.service';
import { UiBackButton } from '../../shared/ui/back-button.component';
import { UiBookTile } from '../../shared/ui/book-tile.component';
import { UiDrivePin, claimDeadline } from '../../shared/ui/drive-pin.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiInfiniteScroll } from '../../shared/ui/infinite-scroll.component';

/** Titles per page: the search, seller and book pages' 20. */
const PAGE_SIZE = 20;

/**
 * A book drive's public page (/<region>/drive?id=): the student organization
 * giving books away, until when it takes registrations, and every title it
 * still has as a book tile with copies left, registrations and 登記領取.
 * Paged as the seller and book pages are: 20 a page with page numbers on a
 * desktop, more appended as the phone scrolls. The page has every title
 * already, so a page is a slice of it rather than another request.
 * Laid out as a course page is (course-detail.ts): title, lead, a status box,
 * then the books.
 */
@Component({
  selector: 'app-drive',
  standalone: true,
  imports: [
    CommonModule,
    TPipe,
    UiBackButton,
    UiBookTile,
    UiDrivePin,
    UiEmpty,
    UiErrorState,
    UiSkeleton,
    UiPagination,
    UiInfiniteScroll,
  ],
  template: `
    <div class="container container--narrow drive-page">
      <ui-back-button></ui-back-button>

      <ui-skeleton *ngIf="loading" variant="list" [count]="4"></ui-skeleton>
      <ui-empty *ngIf="!loading && notFound" [message]="'drive.notFound' | t"></ui-empty>
      <ui-error-state
        *ngIf="!loading && failed"
        [message]="'common.loadFailed' | t"
        (retry)="load()"
      ></ui-error-state>

      <ng-container *ngIf="!loading && page">
        <p class="drive-kicker"><span class="cond-chip">{{ 'drive.giveaway' | t }}</span></p>
        <h1 class="page-title">{{ page.title }}</h1>
        <p class="drive-lead">{{ page.organization.display_name }}</p>
        <p class="drive-desc" *ngIf="page.description">{{ page.description }}</p>

        <div class="status-box">
          <p class="status-count">
            {{ 'drive.myClaims' | t: { n: page.my_claims, max: page.max_claims_per_user } }}
          </p>
          <p class="status-hint" *ngIf="page.open">
            {{ 'drive.closesAt' | t: { time: deadline } }}
          </p>
          <p class="status-hint" *ngIf="!page.open">{{ 'drive.closedLong' | t }}</p>
          <p class="status-hint">{{ 'drive.howItWorks' | t }}</p>
        </div>

        <h2 class="section-heading">{{ 'drive.titlesHeading' | t: { n: page.titles.length } }}</h2>
        <div class="discover-grid" *ngIf="page.titles.length">
          <ui-book-tile
            *ngFor="let t of shown; trackBy: trackTitle"
            mode="plain"
            [title]="t.book.title"
            [author]="t.book.authors"
            [isbn]="t.book.isbn13 || ''"
            [coverUrl]="t.book.cover_url"
            [link]="['/book']"
            [linkParams]="{ id: t.book.id }"
          >
            <ui-drive-pin
              tile-actions
              [compact]="true"
              [drive]="page"
              [bookId]="t.book.id"
              [bookTitle]="t.book.title"
              [remaining]="t.remaining"
              [claimants]="t.claimants"
              [claim]="t.my_claim"
              (claimChange)="onClaimChange(t, $event)"
            ></ui-drive-pin>
          </ui-book-tile>
        </div>
        <ui-pagination
          *ngIf="!isPhone && page.titles.length > pageSize"
          [total]="page.titles.length"
          [pageSize]="pageSize"
          [currentPage]="currentPage"
          (pageChange)="onPageChange($event)"
        ></ui-pagination>
        <ui-infinite-scroll
          *ngIf="isPhone && shown.length > 0"
          [loading]="pager.loading"
          [hasMore]="pager.hasMore"
          [error]="pager.error"
          (loadMore)="pager.loadMore()"
        ></ui-infinite-scroll>
        <ui-empty *ngIf="!page.titles.length" [message]="'drive.noTitles' | t"></ui-empty>
      </ng-container>
    </div>
  `,
  styles: [
    `
      .drive-page {
        padding-block: var(--space-4);
      }
      .page-title {
        margin-top: var(--space-2);
      }
      .drive-kicker {
        margin: var(--space-4) 0 0;
      }
      .drive-lead {
        color: var(--muted);
        font-size: var(--text-sm);
        margin: 0 0 var(--space-3);
      }
      .drive-desc {
        margin: 0 0 var(--space-4);
        color: var(--ink-soft);
        white-space: pre-line;
        line-height: 1.6;
      }
      /* The course page's .want-box: what stands for you, then the books. */
      .status-box {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: var(--radius-panel);
        background: var(--surface-card);
        box-shadow: var(--shadow-card);
        margin-bottom: var(--space-6);
      }
      .status-count {
        margin: 0;
        font-weight: 500;
      }
      .status-hint {
        margin: 0;
        color: var(--muted);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class DrivePageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private drives = inject(DriveService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private destroyRef = inject(DestroyRef);

  page: DrivePage | null = null;
  /** The titles on screen: one page on a desktop, every page scrolled to so far on a phone. */
  shown: DriveTitle[] = [];
  currentPage = 1;
  readonly pageSize = PAGE_SIZE;
  private isPhoneSignal = injectIsPhone();
  get isPhone(): boolean {
    return this.isPhoneSignal();
  }

  /** The phone's "more as you scroll", as the seller and book pages use it: the next slice of the titles. */
  readonly pager = new PhonePager<DriveTitle>({
    fetchPage: (n) => of({ items: this.slice(n), total: this.page?.titles.length ?? 0 }),
    onAppend: (items) => {
      this.shown = [...this.shown, ...items];
    },
    currentCount: () => this.shown.length,
    total: () => this.page?.titles.length ?? 0,
    cdr: this.cdr,
    destroyRef: this.destroyRef,
  });
  loading = true;
  notFound = false;
  failed = false;
  private id = '';

  get deadline(): string {
    return claimDeadline(this.page?.claim_closes_at ?? null, this.i18n.lang());
  }

  trackTitle = (_: number, t: DriveTitle) => t.book.id;

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      this.id = q.get('id') ?? '';
      this.load();
    });
  }

  load(): void {
    this.loading = true;
    this.notFound = false;
    this.failed = false;
    this.cdr.markForCheck();
    if (!this.id) {
      this.loading = false;
      this.notFound = true;
      return;
    }
    this.drives.drive(this.id).subscribe({
      next: (page) => {
        this.page = page;
        this.showPage(1);
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err: HttpErrorResponse) => {
        this.page = null;
        this.loading = false;
        if (err.status === 404) this.notFound = true;
        else this.failed = true;
        this.cdr.markForCheck();
      },
    });
  }

  private slice(n: number): DriveTitle[] {
    return (this.page?.titles ?? []).slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
  }

  private showPage(n: number): void {
    this.currentPage = n;
    this.shown = this.slice(n);
    this.pager.reset(n, this.page?.titles.length ?? 0);
  }

  onPageChange(n: number): void {
    this.showPage(n);
    this.cdr.markForCheck();
  }

  onClaimChange(t: DriveTitle, claim: DriveClaim | null): void {
    if (!this.page) return;
    if (!t.my_claim && claim) this.page.my_claims += 1;
    if (t.my_claim && !claim) this.page.my_claims = Math.max(0, this.page.my_claims - 1);
    t.my_claim = claim;
    this.page = { ...this.page };
    this.cdr.markForCheck();
  }
}
