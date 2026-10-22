import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminRegionDetailComponent } from './region-detail.component';
import { AdminService } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';
import { ToastService } from '../../core/services/toast.service';

describe('AdminRegionDetailComponent: names in each language', () => {
  it('saves the names as edited, also for a language just added', async () => {
    const updateRegion = vi.fn(() => of({}));
    TestBed.configureTestingModule({
      imports: [AdminRegionDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'HK' }) } } },
        {
          provide: AdminService,
          useValue: {
            getCurrencies: () => of({ count: 0, results: [] }),
            getRegion: () =>
              of({
                code: 'HK', name: 'Hong Kong', languages: ['zh-HK'], default_language: 'zh-HK',
                translations: { 'zh-HK': { name: '香港' } }, edu_email_suffix: [], search_engines: [],
              }),
            updateRegion,
          },
        },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(AdminRegionDetailComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const c = fixture.componentInstance;
    const inputs = () => Array.from(fixture.nativeElement.querySelectorAll('.translation-row input')) as HTMLInputElement[];
    const type = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };

    // Adding a language drew an input bound to item.translations['en'].name,
    // which does not exist yet.
    c.toggleLang('en');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(inputs().length).toBe(2);
    expect(inputs()[0].value).toBe('香港');

    // What is typed is what is saved: the inputs used to edit a copy save() never read.
    type(inputs()[0], '香港特別行政區');
    type(inputs()[1], 'Hong Kong');
    c.save();
    expect(updateRegion).toHaveBeenCalledWith('HK', expect.objectContaining({
      translations: { 'zh-HK': { name: '香港特別行政區' }, en: { name: 'Hong Kong' } },
    }));
  });
});
