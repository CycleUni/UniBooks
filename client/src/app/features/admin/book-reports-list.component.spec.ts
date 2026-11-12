import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { AdminBookReportsListComponent } from './book-reports-list.component';
import { AdminService, AdminBookReport, AdminBook } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthStore } from '../../core/auth.store';

import { AdminEmailVisibility, MASKED_EMAIL } from './admin-email.pipe';

function sampleReport(overrides: Partial<AdminBookReport> = {}): AdminBookReport {
  return {
    id: 'report-1',
    region: 'TW',
    book: {
      id: 'book-1',
      title: 'Operating System Concepts',
      authors: 'Silberschatz',
      publisher: 'Wiley',
      published_date: '2018',
      cover_url: 'https://example.com/os.jpg',
      isbn13: '9781119456339',
      source: 'manual',
    },
    reporter: {
      id: 'user-1',
      email: 'student@example.com',
    },
    fields: ['title', 'authors'],
    detail: 'Authors list is incomplete',
    suggested: {
      authors: 'Silberschatz, Galvin, Gagne',
    },
    status: 'open',
    admin_note: '',
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

function sampleBook(overrides: Partial<AdminBook> = {}): AdminBook {
  return {
    id: 'book-1',
    region: 'TW',
    isbn13: '9781119456339',
    title: 'Operating System Concepts',
    authors: 'Silberschatz',
    publisher: 'Wiley',
    published_date: '2018',
    cover_url: 'https://example.com/os.jpg',
    source: 'manual',
    created_at: '2026-09-01T10:00:00Z',
    active_listings: 2,
    request_count: 1,
    reviewed_at: null,
    pending_review: false,
    open_reports: 1,
    ...overrides,
  };
}

describe('AdminBookReportsListComponent', () => {
  let fixture: ComponentFixture<AdminBookReportsListComponent>;
  let component: AdminBookReportsListComponent;
  let adminService: {
    getBookReports: ReturnType<typeof vi.fn>;
    getBook: ReturnType<typeof vi.fn>;
    actionBookReport: ReturnType<typeof vi.fn>;
    updateBook: ReturnType<typeof vi.fn>;
  };
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let authStore: { user: ReturnType<typeof signal> };

  beforeEach(async () => {
    adminService = {
      getBookReports: vi.fn().mockReturnValue(of({ count: 1, results: [sampleReport()] })),
      getBook: vi.fn().mockReturnValue(of(sampleBook())),
      actionBookReport: vi.fn().mockReturnValue(of(sampleReport({ status: 'fixed' }))),
      updateBook: vi.fn().mockReturnValue(of({ book: sampleBook(), merged_into: null })),
    };
    toast = { success: vi.fn(), error: vi.fn() };
    authStore = {
      user: signal({ id: 'admin-1', email: 'admin@example.com', role: 'admin' }),
    };

    await TestBed.configureTestingModule({
      imports: [AdminBookReportsListComponent],
      providers: [
        provideRouter([]),
        { provide: AdminService, useValue: adminService },
        { provide: ToastService, useValue: toast },
        { provide: AuthStore, useValue: authStore },
        {
          provide: I18nService,
          useValue: {
            t: (key: string) => key,
            tOrNull: (key: string) => key,
            lang: signal('en'),
          },
        },
        {
          provide: RegionService,
          useValue: {
            region: signal('tw'),
            regions: signal([
              { code: 'TW', localized_name: 'Taiwan' },
              { code: 'HK', localized_name: 'Hong Kong' },
            ]),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminBookReportsListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  const el = () => fixture.nativeElement as HTMLElement;

  it('loads book reports with default filters on init', () => {
    expect(adminService.getBookReports).toHaveBeenCalledWith({
      status: 'open',
      page: 1,
      region: 'TW',
      field: undefined,
    });
    expect(component.reports.length).toBe(1);
    expect(el().textContent).toContain('Operating System Concepts');
    expect(el().textContent).toContain(MASKED_EMAIL);
  });

  it('expands row to show current vs suggested value comparison and details', () => {
    expect(el().querySelector('.comparison-table')).toBeNull();

    component.toggleExpand(component.reports[0]);
    fixture.detectChanges();

    expect(el().querySelector('.comparison-table')).not.toBeNull();
    expect(el().textContent).toContain('Silberschatz, Galvin, Gagne');
    expect(el().textContent).toContain('Authors list is incomplete');
  });

  it('marks report as fixed', () => {
    const report = component.reports[0];
    component.markFixed(report);
    expect(adminService.actionBookReport).toHaveBeenCalledWith('report-1', 'fixed');
    expect(toast.success).toHaveBeenCalledWith('admin.bookReports.fixedToast');
  });

  it('opens dismiss dialog, submits optional admin note, and dismisses report', () => {
    const report = component.reports[0];
    component.startDismiss(report);
    fixture.detectChanges();

    expect(component.dismissingReport).toBe(report);
    expect(el().querySelector('.dismiss-dialog')).not.toBeNull();

    component.dismissNote = 'Not a defect';
    adminService.actionBookReport.mockReturnValue(of(sampleReport({ status: 'dismissed' })));
    component.confirmDismiss();

    expect(adminService.actionBookReport).toHaveBeenCalledWith('report-1', 'dismissed', 'Not a defect');
    expect(toast.success).toHaveBeenCalledWith('admin.bookReports.dismissedToast');
    expect(component.dismissingReport).toBeNull();
  });

  it('opens book editor prefilled with suggested values on applyAndFix', () => {
    const report = component.reports[0];
    component.applyAndFix(report);
    fixture.detectChanges();

    expect(adminService.getBook).toHaveBeenCalledWith('book-1');
    expect(component.activeEditReport).toBe(report);
    expect(component.activeEditBook).toBeTruthy();
    expect(component.activeEditBook?.title).toBe('Operating System Concepts');
    expect(component.editorInitialForm.authors).toBe('Silberschatz, Galvin, Gagne');
    expect(el().querySelector('admin-book-edit')).not.toBeNull();
  });

  it('refetches when filters change', () => {
    component.statusFilter = 'fixed';
    component.fieldFilter = 'title';
    component.regionFilter = 'HK';
    component.reload();

    expect(adminService.getBookReports).toHaveBeenLastCalledWith({
      status: 'fixed',
      page: 1,
      region: 'HK',
      field: 'title',
    });
  });

  it('scopes region options for staff users according to managed_regions', () => {
    authStore.user.set({
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'staff',
      managed_regions: ['TW'],
    });

    const options = component.regionOptions;
    expect(options.length).toBe(1);
    expect(options[0].value).toBe('TW');
  });
});
