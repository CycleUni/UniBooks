import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminStudentIdVerificationsListComponent } from './student-id-verifications-list.component';
import { AdminService, AdminStudentIdVerification } from '../../core/services/admin.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { ToastService } from '../../core/services/toast.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

function sampleVerification(overrides: Partial<AdminStudentIdVerification> = {}): AdminStudentIdVerification {
  return {
    id: 'verif-1',
    region: 'TW',
    status: 'pending',
    student_number: 'C10901234',
    reject_reason: '',
    has_image: true,
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    reviewed_at: null,
    reviewed_by_id: null,
    school: {
      id: 10,
      code: 'CLUT',
      name: 'Chihlee University of Technology',
    },
    user: {
      id: 'user-1',
      email: 'student@example.com',
      first_name: 'Alice',
      last_name: 'Chen',
    },
    ...overrides,
  };
}

describe('AdminStudentIdVerificationsListComponent', () => {
  let fixture: ComponentFixture<AdminStudentIdVerificationsListComponent>;
  let component: AdminStudentIdVerificationsListComponent;
  let adminService: {
    getStudentIdVerifications: ReturnType<typeof vi.fn>;
    getStudentIdVerification: ReturnType<typeof vi.fn>;
    getStudentIdVerificationImageBlob: ReturnType<typeof vi.fn>;
    approveStudentIdVerification: ReturnType<typeof vi.fn>;
    rejectStudentIdVerification: ReturnType<typeof vi.fn>;
  };
  let confirms: { ask: ReturnType<typeof vi.fn> };
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    adminService = {
      getStudentIdVerifications: vi.fn().mockReturnValue(
        of({ count: 1, results: [sampleVerification()], pending_count: 1 }),
      ),
      getStudentIdVerification: vi.fn().mockReturnValue(
        of({
          ...sampleVerification(),
          user: {
            id: 'user-1',
            email: 'student@example.com',
            first_name: 'Alice',
            last_name: 'Chen',
            declared_school: { code: 'CLUT', name: 'Chihlee University of Technology' },
          },
          previous_requests: [],
          other_accounts_same_student_number: [],
        }),
      ),
      getStudentIdVerificationImageBlob: vi.fn().mockReturnValue(of(new Blob(['fake-img'], { type: 'image/jpeg' }))),
      approveStudentIdVerification: vi.fn().mockReturnValue(of({ id: 'verif-1', status: 'approved', reviewed_at: '2026-11-01T12:00:00Z' })),
      rejectStudentIdVerification: vi.fn().mockReturnValue(of({ id: 'verif-1', status: 'rejected', reject_reason: 'Blurry photo', reviewed_at: '2026-11-01T12:00:00Z' })),
    };
    confirms = { ask: vi.fn().mockResolvedValue(true) };
    toast = { success: vi.fn(), error: vi.fn() };

    // Mock URL.createObjectURL and URL.revokeObjectURL
    if (!globalThis.URL.createObjectURL) {
      globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    } else {
      vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    }
    if (!globalThis.URL.revokeObjectURL) {
      globalThis.URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => {});
    }

    await TestBed.configureTestingModule({
      imports: [AdminStudentIdVerificationsListComponent],
      providers: [
        provideRouter([]),
        { provide: AdminService, useValue: adminService },
        { provide: ConfirmService, useValue: confirms },
        { provide: ToastService, useValue: toast },
        {
          provide: I18nService,
          useValue: {
            t: (k: string, p?: Record<string, string>) => {
              if (p) return `${k}:${JSON.stringify(p)}`;
              return k;
            },
            tOrNull: (k: string) => k,
            lang: () => 'zh-TW',
          },
        },
        {
          provide: RegionService,
          useValue: {
            region: () => 'tw',
            currentRegionObj: () => ({ code: 'TW' }),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminStudentIdVerificationsListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads pending verifications on init', () => {
    expect(adminService.getStudentIdVerifications).toHaveBeenCalledWith({ page: 1, page_size: 20, status: 'pending' });
    expect(component.items.length).toBe(1);
    expect(component.items[0].id).toBe('verif-1');
    expect(component.total).toBe(1);
  });

  it('filters by status when selection changes', () => {
    component.statusFilter = 'approved';
    component.reload();
    expect(adminService.getStudentIdVerifications).toHaveBeenCalledWith({ page: 1, page_size: 20, status: 'approved' });
  });

  it('expands detail and loads image blob via authenticated stream', () => {
    const item = component.items[0];
    component.toggleExpand(item);

    expect(component.expandedId).toBe('verif-1');
    expect(adminService.getStudentIdVerification).toHaveBeenCalledWith('verif-1');
    expect(adminService.getStudentIdVerificationImageBlob).toHaveBeenCalledWith('verif-1');
    expect(component.currentImageUrl).toBe('blob:mock-url');
  });

  it('collapses detail and revokes blob URL', () => {
    const item = component.items[0];
    component.toggleExpand(item);
    expect(component.currentImageUrl).toBe('blob:mock-url');

    component.toggleExpand(item);
    expect(component.expandedId).toBeNull();
    expect(component.currentImageUrl).toBeNull();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('detects duplicate approved student numbers across other accounts', () => {
    component.selectedDetail = sampleVerification({
      other_accounts_same_student_number: [
        {
          id: 'verif-other',
          user_id: 'user-2',
          email: 'other@example.com',
          first_name: 'Bob',
          last_name: 'Lin',
          status: 'approved',
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    });

    expect(component.hasDuplicateApproved()).toBe(true);

    component.selectedDetail = sampleVerification({
      other_accounts_same_student_number: [
        {
          id: 'verif-other',
          user_id: 'user-2',
          email: 'other@example.com',
          first_name: 'Bob',
          last_name: 'Lin',
          status: 'rejected',
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    });

    expect(component.hasDuplicateApproved()).toBe(false);
  });

  it('approves verification with confirmation and reloads list', async () => {
    const item = component.items[0];
    await component.onApprove(item);

    expect(confirms.ask).toHaveBeenCalled();
    expect(adminService.approveStudentIdVerification).toHaveBeenCalledWith('verif-1');
    expect(toast.success).toHaveBeenCalledWith('common.save');
  });

  it('rejects verification with reason', () => {
    const item = component.items[0];
    component.startReject(item);
    expect(component.rejectingVerification).toBe(item);

    // Cancel reject
    component.cancelReject();
    expect(component.rejectingVerification).toBeNull();

    // Reopen and confirm reject
    component.startReject(item);
    component.rejectReason = 'Card photo is illegible';
    component.confirmReject();

    expect(adminService.rejectStudentIdVerification).toHaveBeenCalledWith('verif-1', 'Card photo is illegible');
    expect(toast.success).toHaveBeenCalledWith('common.save');
    expect(component.rejectingVerification).toBeNull();
  });
});
