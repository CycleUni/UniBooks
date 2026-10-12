import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { BulkImportModalComponent } from './bulk-import-modal.component';
import { TranslationEditorComponent } from './translation-editor.component';
import { AdminService } from '../../core/services/admin.service';
import { RegionService } from '../../core/region.service';

// The school admin used to assume zh-TW everywhere, so a Hong Kong school's
// Chinese name was offered, filed and sampled under the Taiwanese key.
describe('admin translations follow the region', () => {
  describe('TranslationEditorComponent', () => {
    it('offers an empty row for each region language the item lacks', () => {
      const editor = new TranslationEditorComponent();
      editor.fields = [{ key: 'name', placeholder: 'admin.schoolName', type: 'text' }];
      editor.translations = { 'zh-TW': { name: '國立臺灣大學' } };
      editor.languages = ['zh-HK'];

      expect(editor.translationsList.map(t => t.lang)).toEqual(['zh-TW', 'zh-HK']);
    });

    it('does not duplicate a language the item already has', () => {
      const editor = new TranslationEditorComponent();
      editor.languages = ['zh-HK'];
      editor.translations = { 'zh-HK': { name: '香港大學' } };

      expect(editor.translationsList.map(t => t.lang)).toEqual(['zh-HK']);
    });

    it('leaves an unfilled offered row out of what it emits', () => {
      const editor = new TranslationEditorComponent();
      editor.fields = [{ key: 'name', placeholder: 'admin.schoolName', type: 'text' }];
      editor.translations = {};
      editor.languages = ['zh-HK'];
      let emitted: any = null;
      editor.translationsChange.subscribe(v => (emitted = v));

      editor.onChange();
      expect(emitted).toEqual({});

      editor.translationsList[0].data.name = '香港大學';
      editor.onChange();
      expect(emitted).toEqual({ 'zh-HK': { name: '香港大學' } });
    });
  });

  describe('BulkImportModalComponent sample', () => {
    function sampleFor(region: string, languages: string[]) {
      TestBed.configureTestingModule({
        imports: [BulkImportModalComponent],
        providers: [
          { provide: RegionService, useValue: { region: () => region, translationLanguages: () => languages } },
          { provide: AdminService, useValue: {} },
          { provide: HttpClient, useValue: { get: vi.fn(() => of([])) } },
        ],
      });
      const component = TestBed.createComponent(BulkImportModalComponent).componentInstance;
      component.endpoint = 'schools';
      return JSON.parse(component.sampleFormat);
    }

    it('shows a Hong Kong school with a zh-HK name in Hong Kong', () => {
      const [item] = sampleFor('hk', ['zh-HK']);
      expect(item.code).toBe('HKU');
      expect(item.name).toBe('The University of Hong Kong');
      expect(Object.keys(item.translations)).toEqual(['zh-HK']);
    });

    it('keeps the English canonical name in `name`', () => {
      const [item] = sampleFor('tw', ['zh-TW']);
      expect(item.name).toBe('National Taiwan University');
      expect(item.translations['zh-TW'].name).toBe('國立臺灣大學');
    });
  });
});
