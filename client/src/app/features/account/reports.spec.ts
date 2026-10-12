import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReportsComponent } from './reports';
import { provideRouter } from '@angular/router';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n.service';
import { AccountService } from '../../core/services/account.service';
import { of, throwError } from 'rxjs';
import { RegionService } from '../../core/region.service';


describe('ReportsComponent', () => {
  let component: ReportsComponent;
  let fixture: ComponentFixture<ReportsComponent>;
  let mockAccountService: any;

  beforeEach(async () => {
    mockAccountService = {
      getMyListingReports: vi.fn().mockReturnValue(of({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'listing-report-1',
            listing: { id: 'listing-1', title: 'Physics for Scientists' },
            reporter: { id: 'user-1', email: 'me@example.com' },
            reason: 'fake',
            detail: 'Counterfeit textbook',
            status: 'open',
            created_at: '2026-08-25T11:00:00Z',
          }
        ]
      })),
      getMyChatReports: vi.fn().mockReturnValue(of({
        count: 2,
        next: null,
        previous: null,
        results: [
          {
            id: 'report-1',
            conversation: { id: 'conv-1', listing_title: 'Algorithms 4th Edition' },
            reporter: { id: 'user-1', email: 'me@example.com' },
            reported_party: { id: 'user-2', email: 'other@example.com' },
            reason: 'harassment',
            detail: 'Offensive language in chat',
            status: 'open',
            created_at: '2026-08-25T10:00:00Z',
          },
          {
            id: 'report-2',
            conversation: { id: 'conv-2', listing_title: 'Calculus Early Transcendentals' },
            reporter: { id: 'user-1', email: 'me@example.com' },
            reported_party: { id: 'user-3', email: 'spammer@example.com' },
            reason: 'spam',
            detail: '',
            status: 'actioned',
            created_at: '2026-08-24T15:30:00Z',
          }
        ]
      }))
    };

    await TestBed.configureTestingModule({
      imports: [ReportsComponent, HttpClientTestingModule],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        provideRouter([]),
        { provide: AccountService, useValue: mockAccountService },
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ReportsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create and load both listing and chat reports on init', () => {
    expect(component).toBeTruthy();
    expect(mockAccountService.getMyListingReports).toHaveBeenCalledWith(1);
    expect(mockAccountService.getMyChatReports).toHaveBeenCalledWith(1);
    expect(component.reports.length).toBe(3);
    expect(component.totalReports).toBe(3);
  });

  it('should render the list of reports and their status with type badges', () => {
    const el: HTMLElement = fixture.nativeElement;
    const cards = el.querySelectorAll('.report-card');
    expect(cards.length).toBe(3);

    // First card is listing-report-1 (created at 11:00, newer than chat reports)
    expect(cards[0].querySelector('.type-badge')?.textContent).toContain('Listing');
    expect(cards[0].querySelector('.report-main-info')?.textContent).toContain('Fake item');
    expect(cards[0].querySelector('.status-badge')?.textContent).toContain('Under review');
    expect(cards[0].textContent).toContain('Physics for Scientists');
    expect(cards[0].textContent).toContain('Counterfeit textbook');

    // Second card is report-1 (created at 10:00)
    expect(cards[1].querySelector('.type-badge')?.textContent).toContain('Chat');
    expect(cards[1].querySelector('.report-main-info')?.textContent).toContain('Harassment');
    expect(cards[1].querySelector('.status-badge')?.textContent).toContain('Under review');
    expect(cards[1].textContent).toContain('Algorithms 4th Edition');
    expect(cards[1].textContent).toContain('Offensive language in chat');

    // Third card is report-2 (created at 2026-08-24)
    expect(cards[2].querySelector('.type-badge')?.textContent).toContain('Chat');
    expect(cards[2].querySelector('.status-badge')?.textContent).toContain('Action taken');
    expect(cards[2].textContent).toContain('Calculus Early Transcendentals');
  });

  it('should filter by listing reports when listing tab is clicked', () => {
    component.setFilter('listing');
    fixture.detectChanges();

    expect(mockAccountService.getMyListingReports).toHaveBeenCalledWith(1);
    expect(component.reports.length).toBe(1);
    expect(component.reports[0].type).toBe('listing');
    expect(component.reports[0].listing?.title).toBe('Physics for Scientists');
  });

  it('should filter by chat reports when chat tab is clicked', () => {
    component.setFilter('chat');
    fixture.detectChanges();

    expect(mockAccountService.getMyChatReports).toHaveBeenCalledWith(1);
    expect(component.reports.length).toBe(2);
    expect(component.reports[0].type).toBe('chat');
    expect(component.reports[1].type).toBe('chat');
  });

  it('should correctly map reason labels for both listing and chat reports', () => {
    // Chat reports (default / string reason)
    expect(component.reasonLabel('harassment')).toBe('msg.reportReasonHarassment');
    expect(component.reasonLabel('scam')).toBe('msg.reportReasonScam');
    expect(component.reasonLabel('spam')).toBe('msg.reportReasonSpam');
    expect(component.reasonLabel('other')).toBe('msg.reportReasonOther');
    expect(component.reasonLabel('unknown')).toBe('msg.reportReasonOther');

    // Listing reports
    expect(component.reasonLabel('fake', 'listing')).toBe('moderation.reasonFake');
    expect(component.reasonLabel('scam', 'listing')).toBe('moderation.reasonScam');
    expect(component.reasonLabel('other', 'listing')).toBe('moderation.reasonOther');
    expect(component.reasonLabel('unknown', 'listing')).toBe('moderation.reasonOther');

    // Object form
    expect(component.reasonLabel({ id: '1', type: 'listing', reason: 'fake', status: 'open', created_at: '' })).toBe('moderation.reasonFake');
    expect(component.reasonLabel({ id: '2', type: 'chat', reason: 'harassment', status: 'open', created_at: '' })).toBe('msg.reportReasonHarassment');
  });

  // Half the list passed off as all of it, or "no reports" for a failed
  // load, both claim something the page does not know.
  it('shows the error state, not an empty or partial list, when a side fails, and retries', () => {
    mockAccountService.getMyChatReports.mockReturnValueOnce(throwError(() => ({ status: 500 })));
    component.loadReports(1);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(component.loadFailed).toBe(true);
    expect(el.querySelector('ui-error-state')).not.toBeNull();
    expect(el.querySelector('ui-empty')).toBeNull();
    expect(el.querySelector('.report-card')).toBeNull();

    component.loadReports(1);
    fixture.detectChanges();
    expect(component.loadFailed).toBe(false);
    expect(el.querySelectorAll('.report-card').length).toBe(3);
  });
});
