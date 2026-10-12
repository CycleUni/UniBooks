import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { AdminSchoolRequestsListComponent } from './school-requests-list.component';
import { AdminService, AdminSchoolRequest } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { ToastService } from '../../core/services/toast.service';

function row(overrides: Partial<AdminSchoolRequest> = {}): AdminSchoolRequest {
  return {
    id: 11,
    user: { id: 7, email: 'asker@example.com' },
    region: 'TW',
    school_name: 'Example University',
    school_website: 'https://www.example.edu.tw/',
    edu_email: 'student@example.edu.tw',
    status: 'pending',
    admin_note: '',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

describe('AdminSchoolRequestsListComponent', () => {
  let fixture: ComponentFixture<AdminSchoolRequestsListComponent>;
  let component: AdminSchoolRequestsListComponent;
  let adminService: { getSchoolRequests: ReturnType<typeof vi.fn>; updateSchoolRequest: ReturnType<typeof vi.fn> };
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    adminService = {
      getSchoolRequests: vi.fn().mockReturnValue(of({ count: 1, next: null, previous: null, results: [row()] })),
      updateSchoolRequest: vi.fn(),
    };
    toast = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AdminSchoolRequestsListComponent],
      providers: [
        provideRouter([]),
        { provide: AdminService, useValue: adminService },
        { provide: ToastService, useValue: toast },
        { provide: I18nService, useValue: { t: (key: string) => key, tOrNull: () => null, lang: signal('en') } },
        {
          provide: RegionService,
          useValue: { region: signal('tw'), regions: signal([{ code: 'TW', localized_name: 'Taiwan' }]) },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminSchoolRequestsListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  const el = () => fixture.nativeElement as HTMLElement;

  it('opens on the pending queue of the current region', () => {
    expect(adminService.getSchoolRequests).toHaveBeenCalledWith({ page: 1, q: '', status: 'pending', region: 'TW' });
    expect(el().textContent).toContain('Example University');
    expect(el().textContent).toContain('Taiwan');
  });

  it("opens the school's website in a new tab without an opener", () => {
    const link = el().querySelector('a[target="_blank"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.example.edu.tw/');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('links the reporter to their admin user page', () => {
    const link = Array.from(el().querySelectorAll('a')).find(a => a.textContent?.includes('asker@example.com'))!;
    expect(link.getAttribute('href')).toBe('/tw/admin/users/7');
  });

  it('never turns a non-http website into a link target', () => {
    expect(component.safeHref('javascript:alert(1)')).toBeNull();
    expect(component.safeHref('https://ok.example')).toBe('https://ok.example');
  });

  it('refetches from page one when the status filter changes', () => {
    component.page = 3;
    component.statusFilter = '';
    component.onFilterChange();
    expect(adminService.getSchoolRequests).toHaveBeenLastCalledWith({ page: 1, q: '', status: '', region: 'TW' });
  });

  it('saves only what changed and updates the row in place', () => {
    const req = component.requests[0];
    expect(component.isDirty(req)).toBe(false);

    component.drafts[req.id].status = 'added';
    expect(component.isDirty(req)).toBe(true);

    adminService.updateSchoolRequest.mockReturnValue(of(row({ status: 'added' })));
    component.save(req);

    expect(adminService.updateSchoolRequest).toHaveBeenCalledWith(11, { status: 'added' });
    expect(component.requests[0].status).toBe('added');
    expect(component.isDirty(component.requests[0])).toBe(false);
    expect(toast.success).toHaveBeenCalled();
    // In place, not reloaded: the row stays visible under the pending filter.
    expect(adminService.getSchoolRequests).toHaveBeenCalledTimes(1);
  });

  it('sends a note on its own', () => {
    const req = component.requests[0];
    component.drafts[req.id].admin_note = 'Added as example.edu.tw';
    adminService.updateSchoolRequest.mockReturnValue(of(row({ admin_note: 'Added as example.edu.tw' })));
    component.save(req);
    expect(adminService.updateSchoolRequest).toHaveBeenCalledWith(11, { admin_note: 'Added as example.edu.tw' });
  });
});
