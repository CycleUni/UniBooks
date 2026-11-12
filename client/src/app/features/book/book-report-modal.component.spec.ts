import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { BookReportModalComponent } from './book-report-modal.component';
import { BookService } from '../../core/services/book.service';
import { ToastService } from '../../core/services/toast.service';
import { I18nService } from '../../core/i18n.service';

describe('BookReportModalComponent', () => {
  let component: BookReportModalComponent;
  let fixture: ComponentFixture<BookReportModalComponent>;
  let bookService: { reportBook: ReturnType<typeof vi.fn> };
  let toastMock: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    bookService = { reportBook: vi.fn() };
    toastMock = { success: vi.fn(), error: vi.fn() };

    TestBed.configureTestingModule({
      imports: [BookReportModalComponent],
      providers: [
        { provide: BookService, useValue: bookService },
        { provide: ToastService, useValue: toastMock },
        { provide: I18nService, useValue: { t: (k: string, p?: any) => (p?.region ? `${k}:${p.region}` : k), lang: () => 'en' } },
      ],
    });

    fixture = TestBed.createComponent(BookReportModalComponent);
    component = fixture.componentInstance;
    component.bookId = 'book-uuid-1';
    component.bookTitle = 'Test Book Title';
    fixture.detectChanges();
  });

  it('renders title and checkboxes for fields', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#book-report-title')?.textContent).toContain('bookReport.modalTitle');
    expect(el.querySelector('.modal-subtitle')?.textContent).toContain('Test Book Title');
    const checkboxes = el.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(7);
  });

  it('shows suggested input only for checked text fields', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('.suggested-input').length).toBe(0);

    // Check title
    component.toggleField('title');
    fixture.detectChanges();
    expect(el.querySelectorAll('.suggested-input').length).toBe(1);

    // Check authors
    component.toggleField('authors');
    fixture.detectChanges();
    expect(el.querySelectorAll('.suggested-input').length).toBe(2);

    // Check other (does not have suggested input)
    component.toggleField('other');
    fixture.detectChanges();
    expect(el.querySelectorAll('.suggested-input').length).toBe(2);

    // Uncheck title
    component.toggleField('title');
    fixture.detectChanges();
    expect(el.querySelectorAll('.suggested-input').length).toBe(1);
  });

  it('validates that at least one field is selected before submission', () => {
    component.submit();
    fixture.detectChanges();
    expect(component.noFieldSelectedError).toBe(true);
    expect(bookService.reportBook).not.toHaveBeenCalled();
  });

  it('validates detail is provided when other is selected', () => {
    component.toggleField('other');
    component.detail = '   ';
    component.submit();
    fixture.detectChanges();
    expect(component.detailRequiredError).toBe(true);
    expect(bookService.reportBook).not.toHaveBeenCalled();
  });

  it('submits report with suggested values and fires success toast', () => {
    bookService.reportBook.mockReturnValue(of({ id: 'report-1' }));
    const submittedSpy = vi.fn();
    component.submitted.subscribe(submittedSpy);

    component.toggleField('title');
    component.suggested['title'] = 'Correct Title';
    component.detail = 'Fixed title typo';

    component.submit();
    fixture.detectChanges();

    expect(bookService.reportBook).toHaveBeenCalledWith({
      book: 'book-uuid-1',
      fields: ['title'],
      detail: 'Fixed title typo',
      suggested: { title: 'Correct Title' },
    });
    expect(toastMock.success).toHaveBeenCalledWith('bookReport.submittedToast');
    expect(submittedSpy).toHaveBeenCalled();
  });

  it('enters friendly duplicate state when backend returns moderation.errAlreadyReported', () => {
    const response = new Subject<any>();
    bookService.reportBook.mockReturnValue(response);

    component.toggleField('authors');
    component.submit();
    fixture.detectChanges();

    response.error({ error: { error: { code: 'moderation.errAlreadyReported' } } });
    fixture.detectChanges();

    expect(component.alreadyReported).toBe(true);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.already-reported-card')).not.toBeNull();
    expect(el.querySelector('.already-reported-text')?.textContent).toContain('bookReport.alreadyReported');
  });

  it('displays region verification error if user is unverified', () => {
    const response = new Subject<any>();
    bookService.reportBook.mockReturnValue(response);

    component.toggleField('authors');
    component.submit();
    fixture.detectChanges();

    response.error({ error: { error: { code: 'acct.errUnverifiedInRegion', extra: { region: 'TW' } } } });
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.inline-msg.error')?.textContent).toContain('acct.errUnverifiedInRegion:TW');
  });
});
