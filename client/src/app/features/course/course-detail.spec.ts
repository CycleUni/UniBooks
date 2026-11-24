import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { CourseDetailComponent } from './course-detail';
import { CourseService } from '../../core/services/course.service';
import { SchoolPickerService } from '../../core/services/school-picker.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/services/toast.service';
import { GoogleAnalyticsService } from '../../core/services/google-analytics.service';
import { RegionLinkService } from '../../core/region-link.service';
import { I18nService } from '../../core/i18n.service';
import type { CourseDetailDto } from '../../../../../server/src/api-types';

describe('CourseDetailComponent: asking to be told', () => {
  let component: CourseDetailComponent;
  let courses: { detail: ReturnType<typeof vi.fn>; want: ReturnType<typeof vi.fn>; myWants: ReturnType<typeof vi.fn>; unwant: ReturnType<typeof vi.fn> };
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  let ga: { trackRequestCourse: ReturnType<typeof vi.fn> };
  let loggedIn: boolean;
  let router: { navigate: ReturnType<typeof vi.fn>; url: string };

  const detail = (wanted: boolean): CourseDetailDto => ({ key: 'calc', name: 'Calculus', wantCount: wanted ? 1 : 0, wanted, professors: [], books: [] });

  // A code the dictionary knows comes back as itself; anything else is null, as the real lookup does.
  const KNOWN = new Set(['common.errRateLimited']);

  function setup(wanted: boolean) {
    loggedIn = true;
    toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    ga = { trackRequestCourse: vi.fn() };
    router = { navigate: vi.fn(), url: '/tw/course/detail?school=NTU&name=Calculus' };
    courses = {
      detail: vi.fn().mockReturnValue(of(detail(wanted))),
      want: vi.fn().mockReturnValue(of({ id: 'w1', name: 'Calculus', school: 'NTU', created_at: '' })),
      myWants: vi.fn().mockReturnValue(of([{ id: 'w1', name: 'Calculus', school: 'NTU', created_at: '' }])),
      unwant: vi.fn().mockReturnValue(of(undefined)),
    };
    TestBed.configureTestingModule({
      imports: [CourseDetailComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({ school: 'NTU', name: 'Calculus' })) } },
        { provide: Router, useValue: router },
        { provide: CourseService, useValue: courses },
        { provide: SchoolPickerService, useValue: { open: vi.fn() } },
        { provide: AuthStore, useValue: { isLoggedIn: () => loggedIn } },
        { provide: ToastService, useValue: toast },
        { provide: GoogleAnalyticsService, useValue: ga },
        { provide: RegionLinkService, useValue: { path: (c: unknown) => c } },
        {
          provide: I18nService,
          useValue: { t: (k: string) => k, tOrNull: (k: unknown) => (typeof k === 'string' && KNOWN.has(k) ? k : null), lang: signal('en') },
        },
      ],
    });
    const fixture = TestBed.createComponent(CourseDetailComponent);
    fixture.detectChanges();
    component = fixture.componentInstance;
  }

  it('counts the request in analytics, tells the visitor, and shows one more waiting', () => {
    setup(false);
    component.toggleWant();
    expect(courses.want).toHaveBeenCalledWith('NTU', 'Calculus');
    expect(ga.trackRequestCourse).toHaveBeenCalledWith('NTU', 'Calculus');
    expect(toast.success).toHaveBeenCalledWith('course.wantedToast');
    expect(component.detail).toMatchObject({ wanted: true, wantCount: 1 });
  });

  it('tells the visitor when a request is cancelled, as cancelling a book request does', () => {
    setup(true);
    component.toggleWant();
    expect(courses.unwant).toHaveBeenCalledWith('w1');
    expect(toast.success).toHaveBeenCalledWith('course.unwantedToast');
    expect(component.detail).toMatchObject({ wanted: false, wantCount: 0 });
  });

  it('gives the server\'s own message when it has one, else a sentence for what was attempted', () => {
    setup(false);
    courses.want.mockReturnValue(throwError(() => ({ error: { error: { code: 'common.errRateLimited' } } })));
    component.toggleWant();
    expect(toast.error).toHaveBeenLastCalledWith('common.errRateLimited');
    expect(ga.trackRequestCourse).not.toHaveBeenCalled();

    courses.want.mockReturnValue(throwError(() => ({ status: 500 })));
    component.toggleWant();
    expect(toast.error).toHaveBeenLastCalledWith('course.wantFailed');
  });

  it('says cancelling failed, not that asking did', () => {
    setup(true);
    courses.unwant.mockReturnValue(throwError(() => ({ status: 500 })));
    component.toggleWant();
    expect(toast.error).toHaveBeenLastCalledWith('course.unwantFailed');
    expect(component.busy).toBe(false);
  });

  it('sends a signed-out visitor to log in, and back here after', () => {
    setup(false);
    loggedIn = false;
    component.toggleWant();
    expect(courses.want).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('course.loginToWant');
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: router.url } });
  });
});
