import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER } from 'rxjs';
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
});
