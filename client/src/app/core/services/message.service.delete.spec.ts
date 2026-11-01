import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { MessageService } from './message.service';
import { SessionRefreshService } from '../session-refresh.service';

describe('MessageService.deleteConversation', () => {
  it('calls the route the server has, DELETE /conversations/:id', () => {
    // It was /conversations/:id/delete after the server dropped that suffix,
    // and every delete answered 404.
    const http = { delete: vi.fn(() => of({ status: 'hidden' })) };
    TestBed.configureTestingModule({
      providers: [
        MessageService,
        { provide: HttpClient, useValue: http },
        { provide: SessionRefreshService, useValue: { ensureAccess: () => of(undefined) } },
      ],
    });

    TestBed.inject(MessageService).deleteConversation('c1').subscribe();

    expect(http.delete).toHaveBeenCalledWith('/messaging/conversations/c1');
  });
});
