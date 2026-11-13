import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AdminSchoolsListComponent } from './schools-list.component';
import { AdminService } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';

describe('AdminSchoolsListComponent', () => {
  it('lists the picked region’s schools', () => {
    const getSchools = vi.fn(() => NEVER);
    TestBed.configureTestingModule({
      imports: [AdminSchoolsListComponent],
      providers: [
        provideRouter([]),
        { provide: AdminService, useValue: { getSchools } },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { region: () => 'hk', regions: () => [], translationLanguages: () => ['zh-HK'] } },
        { provide: AuthStore, useValue: { user: () => ({ role: 'admin' }) } },
      ],
    }).overrideComponent(AdminSchoolsListComponent, { set: { template: '' } });
    TestBed.createComponent(AdminSchoolsListComponent).componentInstance.loadPage(1);
    expect(getSchools).toHaveBeenCalledWith(expect.objectContaining({ region: 'HK' }));
  });

  it('toggles requires_verification on a school via adminService.updateSchool', () => {
    const updateSchool = vi.fn().mockReturnValue(of({ id: 's1', requires_verification: true }));
    TestBed.configureTestingModule({
      imports: [AdminSchoolsListComponent],
      providers: [
        provideRouter([]),
        { provide: AdminService, useValue: { getSchools: () => NEVER, updateSchool } },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { region: () => 'hk', regions: () => [], translationLanguages: () => ['zh-HK'] } },
        { provide: AuthStore, useValue: { user: () => ({ role: 'admin' }) } },
      ],
    }).overrideComponent(AdminSchoolsListComponent, { set: { template: '' } });

    const comp = TestBed.createComponent(AdminSchoolsListComponent).componentInstance;
    const school: any = { id: 's1', requires_verification: false };
    const event = { target: { checked: true } } as any;

    comp.toggleVerification(school, event);

    expect(updateSchool).toHaveBeenCalledWith('s1', { requires_verification: true });
    expect(school.requires_verification).toBe(true);
  });
});
