import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { MessageService } from './message.service';

function tokenExpiringIn(seconds: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }));
  return `h.${payload}.s`;
}

describe('MessageService room reconnect', () => {
  let service: MessageService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: 'browser' },
      ],
    });
    service = TestBed.inject(MessageService);
  });

  it('reuses a room token with time left', () => {
    const connect = vi.spyOn(service, 'connectEdgeChat').mockImplementation(() => {});
    const mint = vi.spyOn(service, 'getChatToken');
    const token = tokenExpiringIn(3600);

    (service as any).reconnectRoom('room-1', token, '7', 'https://chat.example');

    expect(mint).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith('room-1', token, '7', 'https://chat.example');
  });

  it('mints a fresh room token for an expired one and hands it on', () => {
    // The room closes a socket whose token expired; reconnecting with the
    // same token could only be refused again, every attempt.
    const connect = vi.spyOn(service, 'connectEdgeChat').mockImplementation(() => {});
    vi.spyOn(service, 'getChatToken').mockReturnValue(of({ token: 'fresh', edge_chat_url: 'https://chat.example' }));
    (service as any).currentRoomId = 'room-1';
    const refreshed: string[] = [];
    service.roomTokenRefreshed$.subscribe(e => refreshed.push(e.token));

    (service as any).reconnectRoom('room-1', tokenExpiringIn(-10), '7', 'https://chat.example');

    expect(connect).toHaveBeenCalledWith('room-1', 'fresh', '7', 'https://chat.example');
    expect(refreshed).toEqual(['fresh']);
  });

  it('drops a fresh token for a conversation the user has left', () => {
    const connect = vi.spyOn(service, 'connectEdgeChat').mockImplementation(() => {});
    vi.spyOn(service, 'getChatToken').mockReturnValue(of({ token: 'fresh', edge_chat_url: '' }));
    (service as any).currentRoomId = 'room-2';

    (service as any).reconnectRoom('room-1', tokenExpiringIn(-10), '7', 'https://chat.example');

    expect(connect).not.toHaveBeenCalled();
  });
});
