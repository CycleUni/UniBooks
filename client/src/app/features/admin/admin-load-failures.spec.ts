import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { AdminUsersListComponent } from './users-list.component';
import { AdminBookRankingComponent } from './book-ranking.component';
import { AdminRegionDetailComponent } from './region-detail.component';
import { AdminSchoolDetailComponent } from './school-detail.component';
import { AdminChatReportsListComponent } from './chat-reports-list.component';
import { I18nService } from '../../core/i18n.service';

// A failed load used to toast and leave the page reading as empty ("no
// data"), blank, or — on the region page — bounce back to the list.
describe('Admin pages on a failed load', () => {
  const i18n = { t: (k: string) => k, tOrNull: (k: string) => k, lang: () => 'en' };
  const fail = () => throwError(() => ({ status: 503 }));

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        provideRouter([]),
        { provide: I18nService, useValue: i18n },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'tw' }), queryParamMap: convertToParamMap({}) }, queryParamMap: of(convertToParamMap({})), paramMap: of(convertToParamMap({ id: '1' })) } },
      ],
    });
  });

  it('a list shows the error with a retry instead of "no data"', () => {
    const fixture = TestBed.createComponent(AdminUsersListComponent);
    const c = fixture.componentInstance;
    const getUsers = vi.fn().mockReturnValue(of({ count: 0, results: [] }));
    (c as any).adminService = { getUsers };
    // The first pass runs the region effect, which loads once on its own.
    fixture.detectChanges();

    getUsers.mockReturnValueOnce(fail());
    c.reload();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('ui-error-state')).not.toBeNull();
    expect(el.querySelector('table')).toBeNull();

    (el.querySelector('ui-error-state button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('ui-error-state')).toBeNull();
    expect(el.querySelector('table')).not.toBeNull();
  });

  it('a ranking clears to nothing, not to an empty ranking', () => {
    const fixture = TestBed.createComponent(AdminBookRankingComponent);
    const c = fixture.componentInstance;
    (c as any).stats = { getBookRanking: vi.fn(() => fail()) };
    (c as any).region = 'TW';
    c.load();
    expect(c.rows).toBeNull();
    expect(c.loadError).toBe('admin.errLoadFailed');
  });

  it('a region that fails to load stays put and says so', () => {
    const fixture = TestBed.createComponent(AdminRegionDetailComponent);
    const c = fixture.componentInstance;
    (c as any).adminService = { getCurrencies: () => of([]), getRegion: vi.fn(() => fail()) };
    c.ngOnInit();
    expect(c.loadError).toBe('admin.errLoadFailed');
    expect(c.item).toBeFalsy();
  });

  it('a school that fails to load shows the error instead of a blank page', () => {
    const fixture = TestBed.createComponent(AdminSchoolDetailComponent);
    const c = fixture.componentInstance;
    (c as any).adminService = { getSchool: vi.fn(() => fail()) };
    (c as any).schoolId = '1';
    c.loadSchool();
    expect(c.loadError).toBe('admin.errLoadFailed');
  });

  // Expanding a chat report fetches its conversation; a failure used to be a
  // toast and nothing in the row, and a late answer could land under another.
  describe('chat report messages', () => {
    const token = { token: 't', edge_chat_url: 'https://edge', room_id: 'r' };
    let c: AdminChatReportsListComponent;
    let getChatReportToken: ReturnType<typeof vi.fn>;
    let get: ReturnType<typeof vi.fn>;
    const report = (id: string) => ({ id } as any);

    beforeEach(() => {
      c = TestBed.createComponent(AdminChatReportsListComponent).componentInstance;
      getChatReportToken = vi.fn(() => of(token));
      get = vi.fn();
      (c as any).adminService = { getChatReportToken };
      (c as any).http = { get };
    });

    it('reads the reported room from edge_chat_url with the report\'s token', () => {
      c.toggleExpand(report('a'));
      get.mockReturnValueOnce(of([]));
      c.loadMessages('a');
      expect(get).toHaveBeenCalledWith(
        'https://edge/api/chat/rooms/r/messages',
        { headers: { Authorization: 'Bearer t', 'ngsw-bypass': 'true' } },
      );
    });

    it('shows the failure in the row and retries', () => {
      c.toggleExpand(report('a'));
      get.mockReturnValueOnce(fail());
      c.loadMessages('a');
      expect(c.messagesError).toBe('admin.errLoadFailed');
      expect(c.loadingMessages).toBe(false);

      get.mockReturnValueOnce(of([{ user_id: 1, content: 'hi' }]));
      c.loadMessages('a');
      expect(c.messagesError).toBe('');
      expect(c.messages?.length).toBe(1);
    });

    it('drops an answer for a row no longer expanded', () => {
      const pending = new Subject<any[]>();
      get.mockReturnValueOnce(pending);
      c.toggleExpand(report('a'));
      c.loadMessages('a');
      c.toggleExpand(report('b'));
      expect(c.loadingMessages).toBe(false);

      pending.next([{ user_id: 1, content: 'from a' }]);
      expect(c.messages).toBeNull();
    });
  });
});
