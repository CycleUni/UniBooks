import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { NEVER, Subject, throwError } from 'rxjs';
import { AdminCategoriesListComponent, departmentsToText, textToDepartments } from './categories-list.component';
import { AdminService } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';

describe('AdminCategoriesListComponent: create', () => {
  let admin: { getCategories: ReturnType<typeof vi.fn>; createCategory: ReturnType<typeof vi.fn> };

  function create() {
    admin = { getCategories: vi.fn(() => NEVER), createCategory: vi.fn() };
    TestBed.configureTestingModule({
      imports: [AdminCategoriesListComponent],
      providers: [
        provideRouter([]),
        { provide: AdminService, useValue: admin },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { region: () => 'hk', regions: () => [] } },
        { provide: AuthStore, useValue: { user: () => ({ role: 'admin' }) } },
      ],
    }).overrideComponent(AdminCategoriesListComponent, { set: { template: '' } });
    const c = TestBed.createComponent(AdminCategoriesListComponent).componentInstance;
    c.form = { slug: 'math', title: 'Math', description: '', sort_order: 0, is_active: true };
    return c;
  }

  it('sends the region a new category belongs to, once while it is on its way', () => {
    const c = create();
    admin.createCategory.mockReturnValue(new Subject());
    c.saveCategory();
    c.saveCategory();
    expect(admin.createCategory).toHaveBeenCalledTimes(1);
    expect(admin.createCategory.mock.calls[0][0]).toMatchObject({ slug: 'math', region: 'HK' });
  });

  it('says why a create was refused, and lets it be tried again', () => {
    const c = create();
    admin.createCategory.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 400, error: { error: { code: 'common.errValidation', fields: { slug: ['admin.errSlugTaken'] } } } })),
    );
    c.saveCategory();
    expect(c.formError).not.toBe('');
    expect(c.saving).toBe(false);
  });

  it('sends the departments typed one per line, full name first', () => {
    const c = create();
    admin.createCategory.mockReturnValue(new Subject());
    c.departmentsText = '資訊管理學系, 資管\n\n會計學系，會計、ACCT\n統計學系';
    c.saveCategory();
    expect(admin.createCategory.mock.calls[0][0].departments).toEqual([
      { name: '資訊管理學系', aliases: ['資管'] },
      { name: '會計學系', aliases: ['會計', 'ACCT'] },
      { name: '統計學系', aliases: [] },
    ]);
  });
});

describe('department text', () => {
  it('round-trips through the editor lines', () => {
    const departments = [
      { name: '資訊管理學系', aliases: ['資管', '資訊管理系'] },
      { name: '法律學系', aliases: [] },
    ];
    expect(departmentsToText(departments)).toBe('資訊管理學系, 資管, 資訊管理系\n法律學系');
    expect(textToDepartments(departmentsToText(departments))).toEqual(departments);
  });
});
