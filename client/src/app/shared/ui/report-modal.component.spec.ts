import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { UiReportModal } from './report-modal.component';

describe('UiReportModal', () => {
  const post = vi.fn(() => of({}));

  function create() {
    TestBed.configureTestingModule({
      imports: [UiReportModal],
      providers: [{ provide: HttpClient, useValue: { post } }],
    });
    const fixture = TestBed.createComponent(UiReportModal);
    const c = fixture.componentInstance;
    c.conversationId = 'c1';
    c.reportedPartyId = 'u2';
    c.reason = 'spam';
    return { fixture, c };
  }

  beforeEach(() => { post.mockClear(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('files a report once: after it is sent, Submit does nothing', () => {
    const { c } = create();
    c.submit();
    c.submit();
    expect(post).toHaveBeenCalledTimes(1);
    expect(c.success).not.toBe('');
  });

  it('closes itself after the confirmation, but not once it is already gone', () => {
    const { fixture, c } = create();
    let closed = 0;
    c.close.subscribe(() => closed++);
    c.submit();
    fixture.destroy();
    vi.advanceTimersByTime(3000);
    expect(closed).toBe(0);
  });
});
