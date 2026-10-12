import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SimpleChange } from '@angular/core';
import { of } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { BulkImportModalComponent, defaultSchoolsJsonUrl } from './bulk-import-modal.component';
import { AdminService } from '../../core/services/admin.service';
import { RegionService } from '../../core/region.service';


describe('BulkImportModalComponent', () => {
  let fixture: ComponentFixture<BulkImportModalComponent>;
  let component: BulkImportModalComponent;
  let mockAdminService: { bulkImport: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAdminService = {
      bulkImport: vi.fn().mockReturnValue(of({ new: [], modified: [], unchanged: [] })),
    };

    TestBed.configureTestingModule({
      imports: [BulkImportModalComponent],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), translationLanguages: () => ['zh-TW'] } },
        { provide: AdminService, useValue: mockAdminService },
        { provide: HttpClient, useValue: { get: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(BulkImportModalComponent);
    component = fixture.componentInstance;
    component.endpoint = 'schools';
  });

  it('accepts root array JSON in preview()', () => {
    const items = [{ name: 'A', email_domain: 'a.edu.tw' }];
    component.jsonText = JSON.stringify(items);

    component.preview();

    expect(mockAdminService.bulkImport).toHaveBeenCalledWith('schools', 'preview', items);
    expect(component.step).toBe('preview');
    expect(component.errorMsg).toBe('');
  });

  it('accepts object with items array JSON in preview()', () => {
    const items = [{ name: 'B', email_domain: 'b.edu.tw' }];
    component.jsonText = JSON.stringify({ _comment: 'fixture', items });

    component.preview();

    expect(mockAdminService.bulkImport).toHaveBeenCalledWith('schools', 'preview', items);
    expect(component.step).toBe('preview');
    expect(component.errorMsg).toBe('');
  });

  it('shows clear error when JSON format is unsupported', () => {
    component.jsonText = JSON.stringify({ foo: [] });

    component.preview();

    expect(mockAdminService.bulkImport).not.toHaveBeenCalled();
    expect(component.step).toBe('input');
    expect(component.errorMsg).toContain('JSON format must be an array [...] or an object with items array');
  });

  it('does not call API when all items are invalid', () => {
    component.jsonText = JSON.stringify([{ name: 'No domain' }, { email_domain: '   ' }]);

    component.preview();

    expect(mockAdminService.bulkImport).not.toHaveBeenCalled();
    expect(component.errorMsg).toContain('All items are invalid');
    expect(component.step).toBe('input');
  });

  it('sends only valid items and shows warning when partial invalid items exist', () => {
    const validItem = { name: 'Valid', email_domain: 'valid.edu.tw' };
    const invalidItem = { name: 'Invalid' };
    component.jsonText = JSON.stringify([validItem, invalidItem]);

    component.preview();

    expect(mockAdminService.bulkImport).toHaveBeenCalledWith('schools', 'preview', [validItem]);
    expect(component.warningMsg).toContain('1 invalid item(s) were skipped');
    expect(component.errorMsg).toBe('');
  });

  it('shows summary even when preview result is all zero', () => {
    component.show = true;
    component.jsonText = JSON.stringify([{ name: 'Valid', email_domain: 'valid.edu.tw' }]);

    component.preview();
    fixture.detectChanges();

    const html = fixture.nativeElement as HTMLElement;
    expect(component.totalCount).toBe(0);
    expect(html.textContent).toContain('Summary');
    expect(html.textContent).toContain('New: 0');
    expect(html.textContent).toContain('Modified: 0');
    expect(html.textContent).toContain('Unchanged: 0');
    expect(html.textContent).toContain('No valid changes found in preview result.');
  });

  it('renders capped preview items and shows hidden counts', () => {
    const previewLimit = component.PREVIEW_ITEM_LIMIT;
    const newItems = Array.from({ length: previewLimit + 5 }, (_, i) => ({
      email_domain: `new-${i}.edu.tw`,
      name: `New ${i}`,
    }));
    const modifiedItems = Array.from({ length: previewLimit + 3 }, (_, i) => ({
      old: { slug: `old-${i}`, title: `Old ${i}` },
      new: { slug: `new-${i}`, title: `New ${i}` },
    }));

    mockAdminService.bulkImport.mockReturnValue(of({ new: newItems, modified: modifiedItems, unchanged: [] }));
    component.show = true;
    component.endpoint = 'schools';
    component.jsonText = JSON.stringify([{ name: 'Valid', email_domain: 'valid.edu.tw' }]);

    component.preview();
    fixture.detectChanges();

    const html = fixture.nativeElement as HTMLElement;
    expect(component.previewNewItems.length).toBe(previewLimit);
    expect(component.previewModifiedItems.length).toBe(previewLimit);
    expect(html.querySelectorAll('.diff-section .diff-box > pre').length).toBe(previewLimit);
    expect(html.querySelectorAll('.diff-section .diff-item').length).toBe(previewLimit);
    expect(html.textContent).toContain('5 more new item(s) not shown.');
    expect(html.textContent).toContain('3 more modified item(s) not shown.');
  });

  it('uses precomputed preview strings instead of re-serializing in template', () => {
    const newItem = { email_domain: 'a.edu.tw', name: 'Original' };
    mockAdminService.bulkImport.mockReturnValue(of({ new: [newItem], modified: [], unchanged: [] }));
    component.show = true;
    component.jsonText = JSON.stringify([{ name: 'Valid', email_domain: 'valid.edu.tw' }]);

    component.preview();
    fixture.detectChanges();

    const html = fixture.nativeElement as HTMLElement;
    expect(html.textContent).toContain('"name": "Original"');

    component.diff.new[0].name = 'Mutated';
    fixture.detectChanges();

    expect(html.textContent).toContain('"name": "Original"');
    expect(html.textContent).not.toContain('"name": "Mutated"');
  });

  function open() {
    component.show = true;
    component.ngOnChanges({ show: new SimpleChange(false, true, false) });
  }

  it('fills in the region\'s SchoolList URL when the school import opens', () => {
    open();

    expect(component.jsonUrl).toBe('https://raw.githubusercontent.com/CycleUni/SchoolList/refs/heads/main/schools.TW.json');
  });

  it('derives the URL from any region code', () => {
    expect(defaultSchoolsJsonUrl('hk')).toBe('https://raw.githubusercontent.com/CycleUni/SchoolList/refs/heads/main/schools.HK.json');
  });

  it('keeps a URL the admin typed', () => {
    component.jsonUrl = 'https://example.com/mine.json';

    open();

    expect(component.jsonUrl).toBe('https://example.com/mine.json');
  });

  it('leaves the URL empty for the category import', () => {
    component.endpoint = 'categories';

    open();

    expect(component.jsonUrl).toBe('');
  });
});
