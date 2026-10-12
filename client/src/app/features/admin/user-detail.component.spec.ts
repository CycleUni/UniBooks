import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AdminUserDetailComponent } from './user-detail.component';
import { AdminService } from '../../core/services/admin.service';
import { MetadataService } from '../../core/services/metadata.service';
import { I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { signal } from '@angular/core';
import { vi } from 'vitest';

describe('AdminUserDetailComponent', () => {
  let component: AdminUserDetailComponent;
  let fixture: ComponentFixture<AdminUserDetailComponent>;
  let adminServiceMock: any;

  beforeEach(async () => {
    adminServiceMock = {
      getUser: vi.fn(),
      getSchools: vi.fn(),
      updateUser: vi.fn()
    };

    await TestBed.configureTestingModule({
      imports: [AdminUserDetailComponent],
      providers: [
        { provide: AdminService, useValue: adminServiceMock },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '123' } } } },
        { provide: MetadataService, useValue: {} },
        {
          provide: I18nService,
          useValue: {
            t: (key: string) => key,
            lang: signal('en')
          }
        },
        {
          provide: AuthStore,
          useValue: {
            user: signal({ is_superuser: true })
          }
        },
        {
          provide: RegionService,
          useValue: {
            regions: signal([{ code: 'TW', localized_name: 'Taiwan' }]),
            region: signal('TW')
          }
        }
      ]
    }).compileComponents();
  });

  it('should not clear school to null if it is missing from options', () => {
    const mockUser = {
      id: '123',
      display_name: 'Test',
      is_active: true,
      verifications: [
        { region: 'TW', school: 88, verified_at: '2023-01-01T00:00:00Z' }
      ]
    };

    adminServiceMock.getUser.mockReturnValue(of(mockUser as any));
    // Simulate pagination returning only first 20 schools (missing school 88)
    adminServiceMock.getSchools.mockReturnValue(of({
      count: 88,
      results: [{ id: 1, display_name: 'School 1' }]
    } as any));

    fixture = TestBed.createComponent(AdminUserDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    // Asserts the region is requested, not the exact paging shape: the component
    // now walks pages via `next` instead of asking for one oversized page, and
    // pinning the old arguments here would fail that change without any real
    // behaviour regressing.
    expect(adminServiceMock.getSchools).toHaveBeenCalledWith(expect.objectContaining({ region: 'TW' }));
    
    // Simulate user "clearing" the field (newState.school becomes '')
    // This can happen if the UI shows the dropdown as empty, and they save without touching it,
    // or if they explicitly select the '---' empty option.
    component.verificationStates['TW'].school = '';
    
    // Simulate user changing verified state to trigger a save payload
    component.verificationStates['TW'].verified = false;

    adminServiceMock.updateUser.mockReturnValue(of({} as any));
    
    component.save();

    // It should have called updateUser, but WITHOUT the school field, because we blocked clearing it!
    expect(adminServiceMock.updateUser).toHaveBeenCalledWith('123', expect.objectContaining({
       verified: false
    }));
    
    const updateCall = adminServiceMock.updateUser.mock.calls[0][1];
    expect(updateCall.hasOwnProperty('school')).toBe(false);
  });

  it('should update school to null if it was IN the options', () => {
    const mockUser = {
      id: '123',
      display_name: 'Test',
      is_active: true,
      verifications: [
        { region: 'TW', school: 1, verified_at: '2023-01-01T00:00:00Z' }
      ]
    };

    adminServiceMock.getUser.mockReturnValue(of(mockUser as any));
    adminServiceMock.getSchools.mockReturnValue(of({
      count: 2,
      results: [{ id: 1, display_name: 'School 1' }]
    } as any));

    fixture = TestBed.createComponent(AdminUserDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    // Simulate clearing
    component.verificationStates['TW'].school = '';
    
    adminServiceMock.updateUser.mockReturnValue(of({} as any));
    
    component.save();

    expect(adminServiceMock.updateUser).toHaveBeenCalledWith('123', expect.objectContaining({
       school: null
    }));
  });
});
