import { ChangeDetectorRef, Component, DestroyRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UiButton } from '../../shared/ui/button.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiBookTile } from '../../shared/ui/book-tile.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiBreadcrumb, BreadcrumbItem } from '../../shared/ui/breadcrumb.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { RegionLinkService } from '../../core/region-link.service';
import { CourseService } from '../../core/services/course.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { ToastService } from '../../core/services/toast.service';
import { bookQueryParams } from '../../core/book-preview';
import { SchoolPickerService } from '../../core/services/school-picker.service';
import { courseScope } from './course-school';
import { COURSE_PAGE_STYLES } from './course-styles';
import type { CourseDetailDto } from '../../../../../server/src/api-types';

/** One course: the books past students used for it, and "I am taking this course". */
@Component({
  selector: 'app-course-detail',
  standalone: true,
  imports: [CommonModule, UiButton, UiEmpty, UiBookTile, UiSkeleton, UiErrorState, UiBreadcrumb, TPipe],
  template: `
    <div class="container container--narrow course-page">
      <ui-breadcrumb [items]="breadcrumbItems"></ui-breadcrumb>

      <ui-skeleton *ngIf="!ready" variant="list" [count]="4"></ui-skeleton>
      <!-- No school yet: the picker opens over the page; this stays behind it, and brings it back if it was dismissed. -->
      <ng-container *ngIf="ready && (!school || !name)">
        <ui-empty [message]="'course.pickSchool' | t"></ui-empty>
        <ui-button class="choose-school" (onClick)="chooseSchool()">{{ 'course.chooseSchool' | t }}</ui-button>
      </ng-container>

      <ng-container *ngIf="school && name">
        <ui-skeleton *ngIf="loading" variant="list" [count]="4"></ui-skeleton>
        <ui-error-state *ngIf="!loading && loadFailed" [message]="'common.error' | t" (retry)="load()"></ui-error-state>
        <ng-container *ngIf="!loading && !loadFailed && detail">
          <h1 class="page-title">{{ detail.name }}</h1>
          <p class="course-lead" *ngIf="detail.professors.length">{{ 'course.professors' | t:{names: detail.professors.join('、')} }}</p>
          <div class="want-box">
            <p class="want-count">
              <ng-container *ngIf="detail.wantCount > 0">{{ 'course.wantCount' | t:{n: detail.wantCount} }}</ng-container>
              <ng-container *ngIf="detail.wantCount === 0">{{ 'course.wantNone' | t }}</ng-container>
            </p>

            <!-- Not yet asked. Asking to be told matters most when nothing is for sale: the button leads then,
                 and steps back when there is stock to buy now. -->
            <ng-container *ngIf="!detail.wanted">
              <ui-button [variant]="stockCount > 0 ? 'secondary' : 'primary'" [disabled]="busy" (onClick)="toggleWant()">{{ 'course.want' | t }}</ui-button>
              <p class="want-hint">
                <ng-container *ngIf="stockCount > 0">{{ 'course.wantHintStock' | t:{n: stockCount} }}</ng-container>
                <ng-container *ngIf="stockCount === 0">{{ 'course.wantHintEmpty' | t }}</ng-container>
              </p>
            </ng-container>

            <!-- Asked: the state is a line of text, and the only control left is the quiet way out. -->
            <ng-container *ngIf="detail.wanted">
              <p class="want-status">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {{ 'course.wantedStatus' | t }}
              </p>
              <ui-button variant="ghost" [disabled]="busy" (onClick)="toggleWant()">{{ 'course.unwant' | t }}</ui-button>
            </ng-container>
          </div>

          <h2 class="section-heading">{{ 'course.booksHeading' | t }}</h2>
          <div class="discover-grid" *ngIf="detail.books.length > 0">
            <ui-book-tile
              *ngFor="let b of detail.books"
              [title]="b.title"
              [author]="b.authors"
              [isbn]="b.isbn"
              [coverUrl]="b.coverUrl"
              [sellerCount]="b.activeCount"
              [minPrice]="b.minPrice"
              [link]="['/book']"
              [linkParams]="bookParams(b)"
            ></ui-book-tile>
          </div>
          <ui-empty *ngIf="detail.books.length === 0" [message]="'course.noBooks' | t"></ui-empty>
        </ng-container>
      </ng-container>
    </div>
  `,
  styles: [COURSE_PAGE_STYLES, `
    .want-box {
      display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px;
      border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--surface-card);
      box-shadow: var(--shadow-card); margin-bottom: var(--space-4);
    }
    /* ui-button stretches to its container by default; here it is one action among text, not a bar. */
    .want-box ui-button { align-self: flex-start; }
    .want-count { margin: 0; font-weight: 500; }
    .want-hint { margin: 0; color: var(--muted); font-size: var(--text-sm); }
    .want-status { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--accent); font-size: var(--text-sm); }
  `],
})
export class CourseDetailComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private destroyRef = inject(DestroyRef);
  private courseService = inject(CourseService);
  private schoolState = inject(SchoolStateService);
  private auth = inject(AuthStore);
  private regionLink = inject(RegionLinkService);
  private schoolPicker = inject(SchoolPickerService);
  private toast = inject(ToastService);
  readonly i18n = inject(I18nService);

  /** The school (or its absence) has been settled; before that there is nothing to show. */
  ready = false;
  school = '';
  name = '';
  detail: CourseDetailDto | null = null;
  loading = true;
  loadFailed = false;
  busy = false;

  constructor() {
    courseScope(this.route, this.schoolState)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ school, name }) => {
        this.ready = true;
        this.cdr.markForCheck();
        if (!school) this.chooseSchool();
        this.school = school;
        this.name = name;
        this.load();
      });
  }

  chooseSchool() {
    this.schoolPicker.open();
  }

  /** Copies for sale now across the course's books. */
  get stockCount(): number {
    return this.detail?.books.reduce((sum, b) => sum + b.activeCount, 0) ?? 0;
  }

  get breadcrumbItems(): BreadcrumbItem[] {
    return [
      { labelKey: 'nav.home', link: '/' },
      { labelKey: 'course.title', link: '/course', queryParams: this.school ? { school: this.school } : undefined },
      { label: this.detail?.name ?? this.name },
    ];
  }

  load() {
    if (!this.school || !this.name) {
      this.loading = false;
      this.cdr.markForCheck();
      return;
    }
    this.loading = true;
    this.loadFailed = false;
    this.courseService.detail(this.school, this.name).subscribe({
      next: (d) => {
        this.detail = d;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load course', err);
        this.loadFailed = true;
        this.loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  bookParams(b: { isbn: string; id: string }): Record<string, string | number> {
    return bookQueryParams({ isbn: b.isbn, id: b.id });
  }

  toggleWant() {
    if (!this.detail || this.busy) return;
    if (!this.auth.isLoggedIn()) {
      this.toast.info(this.i18n.t('course.loginToWant'));
      this.router.navigate(this.regionLink.path(['/login']), { queryParams: { returnUrl: this.router.url } });
      return;
    }
    this.busy = true;
    const d = this.detail;
    const settle = () => {
      this.busy = false;
      this.cdr.markForCheck();
    };
    const failed = () => {
      this.toast.error(this.i18n.t('course.wantFailed'));
      settle();
    };
    if (!d.wanted) {
      this.courseService.want(this.school, d.name).subscribe({
        next: () => {
          d.wanted = true;
          d.wantCount += 1;
          this.toast.success(this.i18n.t('course.wantedToast'));
          settle();
        },
        error: failed,
      });
      return;
    }
    // Withdrawing needs the request's id, which only the user's own list carries.
    this.courseService.myWants().subscribe({
      next: (mine) => {
        const own = mine.find((w) => w.school === this.school && w.name.trim() === d.name.trim());
        if (!own) {
          d.wanted = false;
          settle();
          return;
        }
        this.courseService.unwant(own.id).subscribe({
          next: () => {
            d.wanted = false;
            d.wantCount = Math.max(0, d.wantCount - 1);
            settle();
          },
          error: failed,
        });
      },
      error: failed,
    });
  }
}
