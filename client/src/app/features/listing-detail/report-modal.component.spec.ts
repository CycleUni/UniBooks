import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ReportModalComponent } from './report-modal.component';
import { ListingService } from '../../core/services/listing.service';
import { I18nService } from '../../core/i18n.service';

describe('ReportModalComponent', () => {
  it('shows why a report was refused once the request fails', () => {
    const response = new Subject<void>();
    TestBed.configureTestingModule({
      imports: [ReportModalComponent],
      providers: [
        { provide: ListingService, useValue: { reportListing: () => response } },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'en' } },
      ],
    });
    const fixture = TestBed.createComponent(ReportModalComponent);
    fixture.componentInstance.listingId = 'l1';
    fixture.detectChanges();

    fixture.componentInstance.submit();
    fixture.detectChanges();
    // The answer arrives later, outside any event in this component.
    response.error({ error: { error: { code: 'moderation.errAlreadyReported' } } });
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.inline-msg.error')?.textContent).toContain('moderation.errAlreadyReported');
    expect(el.textContent).not.toContain('moderation.submitting');
  });
});
