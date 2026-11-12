import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { AdminSchoolDetailComponent } from './school-detail.component';
import { AdminService, AdminSchool } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { MetadataService } from '../../core/services/metadata.service';
import { ToastService } from '../../core/services/toast.service';

describe('AdminSchoolDetailComponent', () => {
  let component: AdminSchoolDetailComponent;
  let adminServiceMock: any;

  const mockSchool: AdminSchool = {
    id: 1,
    name: 'Chihlee University of Technology',
    display_name: 'Chihlee University of Technology',
    email_domain: 'chihlee.edu.tw',
    code: 'CHIHLEE',
    region: 'TW',
    city: 'NTPC',
    email_domains: ['gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
    student_email_domain: 'gm.chihlee.edu.tw',
    google_domains: ['gm.chihlee.edu.tw'],
    translations: {},
  };

  beforeEach(() => {
    adminServiceMock = {
      getSchool: vi.fn().mockReturnValue(of(mockSchool)),
      updateSchool: vi.fn().mockReturnValue(of({ success: true, school: mockSchool })),
    };

    TestBed.configureTestingModule({
      imports: [AdminSchoolDetailComponent],
      providers: [
        { provide: AdminService, useValue: adminServiceMock },
        {
          provide: I18nService,
          useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' },
        },
        {
          provide: RegionService,
          useValue: {
            region: () => 'tw',
            translationLanguagesFor: () => ['en', 'zh-TW'],
          },
        },
        {
          provide: MetadataService,
          useValue: { getMetadata: vi.fn().mockReturnValue(of({ cities: [] })) },
        },
        {
          provide: ToastService,
          useValue: {
            success: vi.fn(),
            error: vi.fn(),
            working: () => (source: any) => source,
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(new Map([['id', '1']])),
          },
        },
      ],
    }).overrideComponent(AdminSchoolDetailComponent, { set: { template: '' } });

    const fixture = TestBed.createComponent(AdminSchoolDetailComponent);
    component = fixture.componentInstance;
  });

  it('loads school mailbox domains, student email domain, and google domains', () => {
    component.ngOnInit();
    expect(adminServiceMock.getSchool).toHaveBeenCalledWith('1');
    expect(component.editData.email_domain).toBe('chihlee.edu.tw');
    expect(component.editData.email_domains).toEqual(['gm.chihlee.edu.tw', 'mail.chihlee.edu.tw']);
    expect(component.emailDomainsText).toBe('gm.chihlee.edu.tw\nmail.chihlee.edu.tw');
    expect(component.editData.student_email_domain).toBe('gm.chihlee.edu.tw');
    expect(component.editData.google_domains).toEqual(['gm.chihlee.edu.tw']);
    expect(component.acceptedDomainOptions).toEqual([
      'chihlee.edu.tw',
      'gm.chihlee.edu.tw',
      'mail.chihlee.edu.tw',
    ]);
  });

  it('updates accepted domain options when editing additional mailbox domains', () => {
    component.ngOnInit();
    component.onEmailDomainsChange('alumni.chihlee.edu.tw\nother.org');
    expect(component.editData.email_domains).toEqual(['alumni.chihlee.edu.tw', 'other.org']);
    expect(component.acceptedDomainOptions).toContain('alumni.chihlee.edu.tw');
    expect(component.acceptedDomainOptions).toContain('other.org');
    expect(component.acceptedDomainOptions).toContain('chihlee.edu.tw');
  });

  it('toggles Google Workspace domain checkbox correctly', () => {
    component.ngOnInit();
    expect(component.isGoogleDomain('gm.chihlee.edu.tw')).toBe(true);
    expect(component.isGoogleDomain('mail.chihlee.edu.tw')).toBe(false);

    // Toggle on mail.chihlee.edu.tw
    component.toggleGoogleDomain('mail.chihlee.edu.tw', {
      target: { checked: true },
    } as unknown as Event);
    expect(component.isGoogleDomain('mail.chihlee.edu.tw')).toBe(true);
    expect(component.editData.google_domains).toContain('mail.chihlee.edu.tw');

    // Toggle off gm.chihlee.edu.tw
    component.toggleGoogleDomain('gm.chihlee.edu.tw', {
      target: { checked: false },
    } as unknown as Event);
    expect(component.isGoogleDomain('gm.chihlee.edu.tw')).toBe(false);
  });

  it('sends email_domains, student_email_domain, and google_domains on save', () => {
    component.ngOnInit();
    component.editData.student_email_domain = 'mail.chihlee.edu.tw';
    component.saveSchool();

    expect(adminServiceMock.updateSchool).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        email_domains: ['gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
        student_email_domain: 'mail.chihlee.edu.tw',
        google_domains: ['gm.chihlee.edu.tw'],
      }),
    );
  });
});
