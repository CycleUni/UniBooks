import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, NEVER } from 'rxjs';
import { AdminBookDetailComponent } from './book-detail-admin.component';
import { AdminService } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';

describe('AdminBookDetailComponent', () => {
  const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0001';

  it('asks for the book by its UUID, not by NaN', () => {
    const getBook = vi.fn(() => NEVER);
    const params = new BehaviorSubject(convertToParamMap({ id: ID }));
    TestBed.configureTestingModule({
      imports: [AdminBookDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: params.value }, paramMap: params } },
        { provide: AdminService, useValue: { getBook } },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' } },
      ],
    }).overrideComponent(AdminBookDetailComponent, { set: { template: '' } });

    TestBed.createComponent(AdminBookDetailComponent);
    expect(getBook).toHaveBeenCalledWith(ID);
    expect(getBook).toHaveBeenCalledTimes(1);
  });
});
