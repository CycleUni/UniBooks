import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, NEVER } from 'rxjs';
import { AdminAdsListComponent } from './ads-list.component';
import { AdminAdvertisersListComponent } from './advertisers-list.component';
import { AdminSchoolsListComponent } from './schools-list.component';
import { AdminService } from '../../core/services/admin.service';
import { ListingService } from '../../core/services/listing.service';
import { MetadataService } from '../../core/services/metadata.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/services/toast.service';

/** A double click on Save sends one create, not two. */
describe('admin create forms send once while a create is on its way', () => {
  function setUp(admin: Record<string, unknown>) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AdminService, useValue: { getAds: () => NEVER, getAdvertisers: () => NEVER, getSchools: () => NEVER, ...admin } },
        { provide: ListingService, useValue: {} },
        { provide: MetadataService, useValue: { getSchools: () => NEVER } },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { region: () => 'tw', regions: () => [], translationLanguages: () => ['zh-TW'] } },
        { provide: AuthStore, useValue: { user: () => ({ role: 'admin' }) } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
  }

  it('ad', () => {
    const createAd = vi.fn(() => new Subject());
    setUp({ createAd });
    TestBed.overrideComponent(AdminAdsListComponent, { set: { template: '' } });
    const c = TestBed.createComponent(AdminAdsListComponent).componentInstance;
    c.formData = { advertiser: 1, title: 'T', image_url: 'https://x/a.png', start_date: '2030-01-01T00:00', end_date: '2030-02-01T00:00', slot_index: 1 };
    c.save();
    c.save();
    expect(createAd).toHaveBeenCalledTimes(1);
  });

  it('advertiser', () => {
    const createAdvertiser = vi.fn(() => new Subject());
    setUp({ createAdvertiser });
    TestBed.overrideComponent(AdminAdvertisersListComponent, { set: { template: '' } });
    const c = TestBed.createComponent(AdminAdvertisersListComponent).componentInstance;
    c.formData = { company_name: 'Acme', contact_email: 'a@example.com', all_regions: true };
    c.save();
    c.save();
    expect(createAdvertiser).toHaveBeenCalledTimes(1);
  });

  it('school', () => {
    const createSchool = vi.fn(() => new Subject());
    setUp({ createSchool });
    TestBed.overrideComponent(AdminSchoolsListComponent, { set: { template: '' } });
    const c = TestBed.createComponent(AdminSchoolsListComponent).componentInstance;
    c.newSchool = { name: 'NTU', email_domain: 'ntu.edu.tw', code: 'NTU' };
    c.createSchool();
    c.createSchool();
    expect(createSchool).toHaveBeenCalledTimes(1);
  });
});
