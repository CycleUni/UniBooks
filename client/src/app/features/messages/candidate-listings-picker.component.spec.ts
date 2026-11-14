import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CandidateListingsPickerComponent } from './candidate-listings-picker.component';
import { MessageService } from '../../core/services/message.service';
import { ToastService } from '../../core/services/toast.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

describe('CandidateListingsPickerComponent', () => {
  let messageServiceMock: any;
  let toastMock: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  const sampleCandidates = [
    {
      id: 'list-101',
      title: 'Linear Algebra',
      isbn: '9780134860244',
      price: 450,
      condition: 'good',
      course_name: 'MATH201',
      cover_url: 'https://example.com/math.jpg',
    },
    {
      id: 'list-102',
      title: 'Microeconomics',
      isbn: '9780134735573',
      price: 500,
      condition: 'like_new',
      course_name: 'ECON101',
      cover_url: '',
    },
  ];

  beforeEach(() => {
    toastMock = { success: vi.fn(), error: vi.fn() };
    messageServiceMock = {
      getCandidateListings: vi.fn(() => of({ results: sampleCandidates, page: 1, total: 2 })),
      attachListing: vi.fn(() => of({ id: 'conv-1', listing_id: 'list-1', listings: [] })),
    };

    TestBed.configureTestingModule({
      imports: [CandidateListingsPickerComponent],
      providers: [
        { provide: MessageService, useValue: messageServiceMock },
        { provide: ToastService, useValue: toastMock },
        {
          provide: I18nService,
          useValue: {
            t: (key: string) => key,
            lang: () => 'en',
          },
        },
        {
          provide: RegionService,
          useValue: {
            currency: () => ({ code: 'TWD', decimal_places: 0 }),
            region: () => 'tw',
            regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }],
          },
        },
      ],
    });
  });

  it('loads candidates on init and renders list', () => {
    const fixture = TestBed.createComponent(CandidateListingsPickerComponent);
    fixture.componentRef.setInput('conversationId', 'conv-1');
    fixture.detectChanges();

    expect(messageServiceMock.getCandidateListings).toHaveBeenCalledWith('conv-1');

    const rows = document.body.querySelectorAll('.candidate-row');
    expect(rows.length).toBe(2);

    const titles = Array.from(document.body.querySelectorAll('.candidate-title')).map((t) => t.textContent?.trim());
    expect(titles).toEqual(['Linear Algebra', 'Microeconomics']);
    fixture.destroy();
  });

  it('shows empty state when no candidates available', () => {
    messageServiceMock.getCandidateListings.mockReturnValueOnce(of({ results: [], page: 1, total: 0 }));

    const fixture = TestBed.createComponent(CandidateListingsPickerComponent);
    fixture.componentRef.setInput('conversationId', 'conv-1');
    fixture.detectChanges();

    expect(document.body.querySelector('ui-empty')).not.toBeNull();
    expect(document.body.querySelectorAll('.candidate-row').length).toBe(0);
    fixture.destroy();
  });

  it('attaches listing on click, shows success toast, and emits listingAdded and closed', () => {
    const updatedConv = { id: 'conv-1', listings: [{ ref: 'list-101' }] };
    messageServiceMock.attachListing.mockReturnValueOnce(of(updatedConv));

    const fixture = TestBed.createComponent(CandidateListingsPickerComponent);
    fixture.componentRef.setInput('conversationId', 'conv-1');
    fixture.detectChanges();

    const listingAddedSpy = vi.fn();
    const closedSpy = vi.fn();
    fixture.componentInstance.listingAdded.subscribe(listingAddedSpy);
    fixture.componentInstance.closed.subscribe(closedSpy);

    const addButtons = document.body.querySelectorAll('.candidate-row ui-button button') as NodeListOf<HTMLButtonElement>;
    addButtons[0].click();

    expect(messageServiceMock.attachListing).toHaveBeenCalledWith('conv-1', 'list-101');
    expect(toastMock.success).toHaveBeenCalledWith('msg.listingAdded');
    expect(listingAddedSpy).toHaveBeenCalledWith(updatedConv);
    expect(closedSpy).toHaveBeenCalled();
    fixture.destroy();
  });

  it('handles load error gracefully', () => {
    messageServiceMock.getCandidateListings.mockReturnValueOnce(throwError(() => new Error('network')));

    const fixture = TestBed.createComponent(CandidateListingsPickerComponent);
    fixture.componentRef.setInput('conversationId', 'conv-1');
    fixture.detectChanges();

    expect(fixture.componentInstance.isLoading).toBe(false);
    expect(fixture.componentInstance.candidates).toEqual([]);
  });
});
