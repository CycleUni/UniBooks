import { ChangeDetectorRef, Component, DestroyRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UiButton } from '../../shared/ui/button.component';
import { UiSearchField } from '../../shared/ui/search-field.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiBreadcrumb, BreadcrumbItem } from '../../shared/ui/breadcrumb.component';
import { TPipe } from '../../core/i18n.service';
import { RegionLinkService } from '../../core/region-link.service';
import { CourseService } from '../../core/services/course.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { SchoolPickerService } from '../../core/services/school-picker.service';
import { courseScope } from './course-school';
import { COURSE_PAGE_STYLES } from './course-styles';
import type { CourseDto } from '../../../../../server/src/api-types';

/**
 * Browse by course: the courses of the selected school. A course opens as its
 * own page (course/detail), like a book does, so the router gives it the page
 * transition and the list keeps its scroll position when the visitor comes back.
 */
@Component({
  selector: 'app-course-list',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiSearchField, UiEmpty, UiSkeleton, UiErrorState, UiBreadcrumb, TPipe],
  template: `
    <div class="container container--narrow course-page">
      <ui-breadcrumb [items]="breadcrumbItems"></ui-breadcrumb>

      <!-- Until the school is known the page has nothing to say yet. -->
      <ui-skeleton *ngIf="!ready" variant="list" [count]="5"></ui-skeleton>
      <!-- No school yet: the picker opens over the page; this stays behind it, and brings it back if it was dismissed. -->
      <ng-container *ngIf="ready && !school">
        <ui-empty [message]="'course.pickSchool' | t"></ui-empty>
        <ui-button class="choose-school" (onClick)="chooseSchool()">{{ 'course.chooseSchool' | t }}</ui-button>
      </ng-container>

      <ng-container *ngIf="school">
        <h1 class="page-title">{{ 'course.title' | t }}</h1>
        <p class="course-lead">{{ 'course.lead' | t:{school: schoolLabel} }}</p>
        <ui-search-field
          class="course-search"
          [placeholder]="'course.searchPlaceholder' | t"
          [ngModel]="query"
          (ngModelChange)="onQuery($event)"
          (search)="searchNow($event)"
        ></ui-search-field>
        <ui-skeleton *ngIf="loading" variant="list" [count]="5"></ui-skeleton>
        <ui-error-state *ngIf="!loading && loadFailed" [message]="'common.error' | t" (retry)="load()"></ui-error-state>
        <ul class="course-list" *ngIf="!loading && !loadFailed && courses.length > 0">
          <li *ngFor="let c of courses">
            <button type="button" class="course-row" (click)="openCourse(c.name)">
              <span class="course-name">{{ c.name }}</span>
              <span class="course-meta">
                {{ 'course.rowListings' | t:{n: c.listingCount} }}
                <ng-container *ngIf="c.wantCount > 0"> · {{ 'course.rowWants' | t:{n: c.wantCount} }}</ng-container>
              </span>
            </button>
          </li>
        </ul>
        <ui-empty *ngIf="!loading && !loadFailed && courses.length === 0" [message]="'course.none' | t"></ui-empty>
      </ng-container>
    </div>
  `,
  styles: [COURSE_PAGE_STYLES, `
    .course-search { display: block; margin-bottom: var(--space-3); }
    .course-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .course-row {
      width: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px; padding: var(--space-3) 14px;
      min-height: var(--tap-min);
      /* A row the visitor taps: an interactive boundary, so --line-strong rather than the hairline. */
      border: 1px solid var(--line-strong); border-radius: var(--radius-panel); background: var(--surface-card); color: var(--ink);
      font: inherit; cursor: pointer;
    }
    .course-row:hover, .course-row:focus-visible { border-color: var(--accent); }
    .course-name { font-weight: 500; }
    .course-meta { color: var(--muted); font-size: var(--text-sm); }
  `],
})
export class CourseListComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private destroyRef = inject(DestroyRef);
  private courseService = inject(CourseService);
  private schoolState = inject(SchoolStateService);
  private regionLink = inject(RegionLinkService);
  private schoolPicker = inject(SchoolPickerService);

  /** The school (or its absence) has been settled; before that there is nothing to show. */
  ready = false;
  school = '';
  query = '';
  courses: CourseDto[] = [];
  /** Only while there is nothing to show yet: a list already on screen is refreshed without a skeleton. */
  loading = true;
  loadFailed = false;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;

  readonly breadcrumbItems: BreadcrumbItem[] = [{ labelKey: 'nav.home', link: '/' }, { labelKey: 'course.title' }];

  constructor() {
    courseScope(this.route, this.schoolState)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ school }) => {
        this.ready = true;
        this.cdr.markForCheck();
        if (!school) this.chooseSchool();
        this.school = school;
        this.load();
      });
    this.destroyRef.onDestroy(() => clearTimeout(this.queryTimer));
  }

  chooseSchool() {
    this.schoolPicker.open();
  }

  get schoolLabel(): string {
    return this.schoolState.getSchoolLabel(this.school);
  }

  load() {
    if (!this.school) {
      this.loading = false;
      this.cdr.markForCheck();
      return;
    }
    // Coming back from a course, the list is the one the visitor left: show it at once, so the
    // browser can restore the scroll position against a page of the same height, then refresh it.
    const kept = this.courseService.lastList(this.school, this.query);
    if (kept) {
      this.courses = kept;
      this.loading = false;
    } else {
      this.loading = true;
    }
    this.loadFailed = false;
    this.courseService.list(this.school, this.query).subscribe({
      next: (rows) => {
        this.courses = rows;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load courses', err);
        this.loadFailed = this.courses.length === 0;
        this.loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  /** Waits for a pause in typing so each keystroke is not a request. */
  onQuery(value: string) {
    this.query = value;
    clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => this.load(), 250);
  }

  /** Enter, or the magnifier: no need to wait for the pause. */
  searchNow(value: string) {
    this.query = value;
    clearTimeout(this.queryTimer);
    this.load();
  }

  openCourse(name: string) {
    this.router.navigate(this.regionLink.path(['/course/detail']), { queryParams: { school: this.school, name } });
  }
}
