import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { MessageService } from './message.service';

// The hub sends a room_update to every participant of a room, the sender
// included (so their own inbox preview moves), and tells the sender's copy
// `self: true`. Only the others' copies make the conversation unread.
describe('MessageService hub room_update unread state', () => {
  let service: MessageService;
  let socket: { onmessage: ((e: { data: string }) => void) | null };

  beforeEach(() => {
    class FakeWebSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      readyState = 1;
      constructor() { socket = this; }
      close() {}
      send() {}
    }
    (globalThis as any).WebSocket = FakeWebSocket;

    TestBed.configureTestingModule({
      providers: [
        MessageService,
        { provide: HttpClient, useValue: { get: vi.fn(() => of({ unread: [], lastReadAt: {}, count: 0 })), post: vi.fn() } },
      ],
    });
    service = TestBed.inject(MessageService);
    service.connectHub('token', '42', 'https://edge.example');
  });

  const push = (payload: Record<string, unknown>) =>
    socket.onmessage?.({ data: JSON.stringify({ type: 'room_update', preview: 'hi', timestamp: 1, ...payload }) });

  it('marks a conversation unread when someone else wrote in it', () => {
    push({ room_id: 'room-1', sender_id: '7', self: false });
    expect(service.conversationUnreadState$.value.get('room-1')).toBe(true);
  });

  it('does not mark a conversation unread for the user\'s own message', () => {
    const updates: string[] = [];
    service.roomUpdates$.subscribe(u => updates.push(u.room_id));

    push({ room_id: 'room-1', sender_id: '42', self: true });

    // The preview still moves; only the unread dot must not appear.
    expect(updates).toEqual(['room-1']);
    expect(service.conversationUnreadState$.value.get('room-1')).toBeUndefined();
  });
});
