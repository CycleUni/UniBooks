import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { AdminBookEditComponent } from './book-edit.component';
import { AdminService } from '../../core/services/admin.service';
import { I18nService } from '../../core/i18n.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { ToastService } from '../../core/services/toast.service';

const MISREAD = {
  isbn13: '6770250629200',
  title: '7天功頂TOEIC',
  authors: 'Neo講師',
  publisher: '',
  published_date: '',
  cover_url: '',
};
const FOUND = {
  isbn13: '9789860629200',
  title: '7天攻頂TOEIC多益閱讀',
  authors: 'Neo講師',
  publisher: '不求人文化',
  published_date: '2021-06-02',
  cover_url: '',
  source: 'google_api',
  existing_book: null,
};

describe('AdminBookEditComponent', () => {
  let admin: { lookupBook: ReturnType<typeof vi.fn>; updateBook: ReturnType<typeof vi.fn> };
  let askDanger: ReturnType<typeof vi.fn>;

  const create = (currentSource: string | null = null) => {
    TestBed.configureTestingModule({
      imports: [AdminBookEditComponent],
      providers: [
        { provide: AdminService, useValue: admin },
        {
          provide: I18nService,
          useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' },
        },
        { provide: ConfirmService, useValue: { askDanger } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(AdminBookEditComponent);
    fixture.componentInstance.bookId = 6;
    fixture.componentInstance.book = { ...MISREAD };
    fixture.componentInstance.currentSource = currentSource;
    fixture.detectChanges();
    fixture.componentInstance.toggle();
    return fixture.componentInstance;
  };

  beforeEach(() => {
    admin = { lookupBook: vi.fn(), updateBook: vi.fn() };
    askDanger = vi.fn();
  });

  it('refuses to look up a number that is no ISBN, without asking the server', () => {
    const editor = create();
    editor.lookUp();
    expect(admin.lookupBook).not.toHaveBeenCalled();
    expect(editor.isbnError).toBe('listing.errInvalidIsbn');
  });

  it('fills the form from the lookup and saves it with the catalogue as the source', () => {
    admin.lookupBook.mockReturnValue(of(FOUND));
    admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: 6, ...FOUND } }));
    const editor = create();
    const saved = vi.fn();
    editor.saved.subscribe(saved);

    editor.form.isbn13 = '978-986-06-2920-0';
    editor.lookUp();
    expect(admin.lookupBook).toHaveBeenCalledWith(6, '9789860629200');
    expect(editor.form.title).toBe(FOUND.title);
    expect(editor.hasUnsavedChanges()).toBe(true);

    editor.save();
    expect(admin.updateBook).toHaveBeenCalledWith(
      6,
      expect.objectContaining({
        isbn13: '9789860629200',
        title: FOUND.title,
        source: 'google_api',
      }),
    );
    expect(admin.updateBook.mock.calls[0][1].merge).toBeUndefined();
    expect(saved).toHaveBeenCalled();
    expect(editor.hasUnsavedChanges()).toBe(false);
  });

  it('asks before merging into the book that has the ISBN, then merges', async () => {
    const conflict = {
      status: 409,
      error: {
        error: { code: 'admin.errBookIsbnTaken', existing_book: { id: 9, title: 'Right' } },
      },
    };
    admin.updateBook
      .mockReturnValueOnce(throwError(() => conflict))
      .mockReturnValueOnce(of({ merged_into: 9, book: { id: 9 } }));
    askDanger.mockResolvedValue(true);
    const editor = create();
    const merged = vi.fn();
    editor.merged.subscribe(merged);

    editor.form.isbn13 = '9789860629200';
    editor.save();
    await vi.waitFor(() => expect(admin.updateBook).toHaveBeenCalledTimes(2));

    expect(askDanger).toHaveBeenCalledWith('admin.book.confirmMerge', {
      confirmLabel: 'admin.book.merge',
    });
    expect(admin.updateBook.mock.calls[1][1]).toEqual(expect.objectContaining({ merge: true }));
    expect(merged).toHaveBeenCalledWith(9);
  });

  it('leaves the book alone when the merge is declined', async () => {
    const conflict = {
      status: 409,
      error: {
        error: { code: 'admin.errBookIsbnTaken', existing_book: { id: 9, title: 'Right' } },
      },
    };
    admin.updateBook.mockReturnValue(throwError(() => conflict));
    askDanger.mockResolvedValue(false);
    const editor = create();

    editor.form.isbn13 = '9789860629200';
    editor.save();
    await vi.waitFor(() => expect(askDanger).toHaveBeenCalled());

    expect(admin.updateBook).toHaveBeenCalledTimes(1);
    expect(editor.open).toBe(true);
  });

  it('shows a refused save on the form', () => {
    admin.updateBook.mockReturnValue(
      throwError(() => ({ status: 400, error: { error: { code: 'admin.errInvalidField' } } })),
    );
    const editor = create();
    editor.form.isbn13 = '';
    editor.save();
    expect(editor.formError).toBe('admin.errInvalidField');
    expect(editor.saving).toBe(false);
  });

  it('needs a title', () => {
    const editor = create();
    editor.form = { ...editor.form, isbn13: '', title: '  ' };
    editor.save();
    expect(editor.titleMissing).toBe(true);
    expect(admin.updateBook).not.toHaveBeenCalled();
  });

  it('saves the other details without touching an old ISBN that fails the check', () => {
    admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: 6 } }));
    const editor = create();
    expect(editor.storedIsbnKept).toBe(true);

    editor.form.title = '7天攻頂TOEIC';
    editor.save();

    const sent = admin.updateBook.mock.calls[0][1];
    expect(sent.title).toBe('7天攻頂TOEIC');
    expect('isbn13' in sent).toBe(false);
  });

  it('drops a lookup answer that arrives after the ISBN was changed', () => {
    const answer = new Subject<any>();
    admin.lookupBook.mockReturnValue(answer);
    const editor = create();

    editor.form.isbn13 = '9789860629200';
    editor.lookUp();
    expect(editor.looking).toBe(true);
    editor.form.isbn13 = '9780131103627';
    editor.onIsbnChange();
    expect(answer.observed).toBe(false);
    expect(editor.looking).toBe(false);
    answer.next({ ...FOUND, existing_book: { id: 9, title: 'Right' } });

    expect(editor.form.isbn13).toBe('9780131103627');
    expect(editor.form.title).toBe(MISREAD.title);
    expect(editor.mergeTarget).toBeNull();
  });

  it('stops labelling the details as catalogue data once the ISBN is changed', () => {
    admin.lookupBook.mockReturnValue(of(FOUND));
    admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: 6 } }));
    const editor = create();
    editor.form.isbn13 = '9789860629200';
    editor.lookUp();

    editor.form.isbn13 = '9780131103627';
    editor.onIsbnChange();
    editor.save();

    expect(admin.updateBook.mock.calls[0][1].source).toBeUndefined();
  });

  it('fills missing catalogue fields with empty text, so a missing title is caught', () => {
    admin.lookupBook.mockReturnValue(of({ ...FOUND, title: null, authors: null }));
    const editor = create();
    editor.form.isbn13 = '9789860629200';
    editor.lookUp();
    expect(editor.form.title).toBe('');
    expect(editor.form.authors).toBe('');

    editor.save();
    expect(editor.titleMissing).toBe(true);
    expect(admin.updateBook).not.toHaveBeenCalled();
  });

  it('warns when the lookup answers from another catalogue than the record', () => {
    admin.lookupBook.mockReturnValue(of({ ...FOUND, source: 'openlibrary_api' }));
    const editor = create('google_api');
    editor.form.isbn13 = FOUND.isbn13;
    editor.lookUp();
    expect(editor.sourceChange).toEqual({ found: 'book.sourceOpenLibrary', current: 'book.sourceGoogle' });

    editor.form.isbn13 = '9780132350884';
    editor.onIsbnChange();
    expect(editor.sourceChange).toBeNull();
  });

  it('does not warn for the same catalogue, or over details a seller typed in', () => {
    admin.lookupBook.mockReturnValue(of(FOUND));
    const same = create('google_api');
    same.form.isbn13 = FOUND.isbn13;
    same.lookUp();
    expect(same.sourceChange).toBeNull();

    TestBed.resetTestingModule();
    const typed = create('manual');
    typed.form.isbn13 = FOUND.isbn13;
    typed.lookUp();
    expect(typed.sourceChange).toBeNull();
  });
});
