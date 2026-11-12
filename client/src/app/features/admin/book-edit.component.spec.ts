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
  let admin: {
    lookupBook: ReturnType<typeof vi.fn>;
    updateBook: ReturnType<typeof vi.fn>;
    uploadBookCover: ReturnType<typeof vi.fn>;
  };
  let askDanger: ReturnType<typeof vi.fn>;
  let ask: ReturnType<typeof vi.fn>;

  const create = (currentSource: string | null = null, extra?: { initialForm?: Partial<typeof MISREAD>; reportIdToFix?: string; open_reports?: number }) => {
    TestBed.configureTestingModule({
      imports: [AdminBookEditComponent],
      providers: [
        { provide: AdminService, useValue: admin },
        {
          provide: I18nService,
          useValue: { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' },
        },
        { provide: ConfirmService, useValue: { askDanger, ask } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(AdminBookEditComponent);
    fixture.componentInstance.bookId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006';
    fixture.componentInstance.book = { ...MISREAD, open_reports: extra?.open_reports };
    fixture.componentInstance.currentSource = currentSource;
    if (extra?.initialForm) fixture.componentInstance.initialForm = extra.initialForm;
    if (extra?.reportIdToFix) fixture.componentInstance.reportIdToFix = extra.reportIdToFix;
    fixture.detectChanges();
    fixture.componentInstance.toggle();
    return fixture.componentInstance;
  };

  beforeEach(() => {
    admin = { lookupBook: vi.fn(), updateBook: vi.fn(), uploadBookCover: vi.fn() };
    askDanger = vi.fn();
    ask = vi.fn().mockResolvedValue(false);
  });

  it('refuses to look up a number that is no ISBN, without asking the server', () => {
    const editor = create();
    editor.lookUp();
    expect(admin.lookupBook).not.toHaveBeenCalled();
    expect(editor.isbnError).toBe('listing.errInvalidIsbn');
  });

  it('fills the form from the lookup and saves it with the catalogue as the source', () => {
    admin.lookupBook.mockReturnValue(of(FOUND));
    admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006', ...FOUND } }));
    const editor = create();
    const saved = vi.fn();
    editor.saved.subscribe(saved);

    editor.form.isbn13 = '978-986-06-2920-0';
    editor.lookUp();
    expect(admin.lookupBook).toHaveBeenCalledWith('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006', '9789860629200');
    expect(editor.form.title).toBe(FOUND.title);
    expect(editor.hasUnsavedChanges()).toBe(true);

    editor.save();
    expect(admin.updateBook).toHaveBeenCalledWith(
      '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006',
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
    admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006' } }));
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
    admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006' } }));
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

  describe('cover image upload control', () => {
    it('refuses file larger than 5MB with upload.errTooLarge', () => {
      const editor = create();
      const largeFile = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
      const event = { target: { files: [largeFile], value: 'big.png' } } as unknown as Event;

      editor.onCoverFileSelected(event);

      expect(editor.coverError).toBe('upload.errTooLarge');
      expect(admin.uploadBookCover).not.toHaveBeenCalled();
      expect(editor.uploadingCover).toBe(false);
    });

    it('refuses unsupported file types with upload.errUnsupportedType', () => {
      const editor = create();
      const svgFile = new File(['<svg></svg>'], 'image.svg', { type: 'image/svg+xml' });
      const event = { target: { files: [svgFile], value: 'image.svg' } } as unknown as Event;

      editor.onCoverFileSelected(event);

      expect(editor.coverError).toBe('upload.errUnsupportedType');
      expect(admin.uploadBookCover).not.toHaveBeenCalled();
      expect(editor.uploadingCover).toBe(false);
    });

    it('uploads valid image, updates form.cover_url and resets uploadingCover', () => {
      admin.uploadBookCover.mockReturnValue(of({ url: 'https://example.com/cover.png' }));
      const editor = create();
      const validFile = new File([new Uint8Array(100)], 'cover.png', { type: 'image/png' });
      const event = { target: { files: [validFile], value: 'cover.png' } } as unknown as Event;

      editor.onCoverFileSelected(event);

      expect(admin.uploadBookCover).toHaveBeenCalledWith(validFile, '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006');
      expect(editor.form.cover_url).toBe('https://example.com/cover.png');
      expect(editor.uploadingCover).toBe(false);
      expect(editor.coverError).toBe('');
    });

    it('displays error on upload failure', () => {
      admin.uploadBookCover.mockReturnValue(
        throwError(() => ({ status: 400, error: { error: { code: 'upload.errTooLarge' } } })),
      );
      const editor = create();
      const validFile = new File([new Uint8Array(100)], 'cover.png', { type: 'image/png' });
      const event = { target: { files: [validFile], value: 'cover.png' } } as unknown as Event;

      editor.onCoverFileSelected(event);

      expect(editor.uploadingCover).toBe(false);
      expect(editor.coverError).toBe('upload.errTooLarge');
    });

    it('clears cover_url and coverError on removeCover()', () => {
      const editor = create();
      editor.form.cover_url = 'https://example.com/old.png';
      editor.coverError = 'some error';

      editor.removeCover();

      expect(editor.form.cover_url).toBe('');
      expect(editor.coverError).toBe('');
    });
  });

  describe('report prefilling and report resolution', () => {
    it('prefills form values when initialForm is provided', () => {
      const editor = create(null, {
        initialForm: {
          title: 'Suggested Title',
          authors: 'Suggested Author',
        },
      });
      expect(editor.form.title).toBe('Suggested Title');
      expect(editor.form.authors).toBe('Suggested Author');
      expect(editor.form.isbn13).toBe(MISREAD.isbn13);
    });

    it('offers to resolve open reports on save and includes resolve_reports: true when confirmed', async () => {
      admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006', ...MISREAD } }));
      ask.mockResolvedValue(true);
      const editor = create(null, { open_reports: 3 });

      await editor.save();

      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'admin.book.confirmCloseReports',
          confirmLabel: 'admin.book.closeReports',
        }),
      );
      expect(admin.updateBook).toHaveBeenCalledWith(
        '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006',
        expect.objectContaining({ resolve_reports: true }),
      );
    });

    it('passes resolve_report_id when reportIdToFix is provided and resolve_reports is declined', async () => {
      admin.updateBook.mockReturnValue(of({ merged_into: null, book: { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006', ...MISREAD } }));
      ask.mockResolvedValue(false);
      const editor = create(null, { open_reports: 1, reportIdToFix: 'rep-123' });

      await editor.save();

      expect(admin.updateBook).toHaveBeenCalledWith(
        '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3d0006',
        expect.objectContaining({ resolve_report_id: 'rep-123' }),
      );
    });
  });
});
