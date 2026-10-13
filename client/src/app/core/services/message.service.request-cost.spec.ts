import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { MessageService } from './message.service';

const wsOrigin = location.origin.replace(/^http/, 'ws');

// Every REST call to the chat server is a billed Worker request, so these pin down the paths that used to multiply them:
// a REST snapshot on every hub connect, a REST mark-read per live message, and
// reconnects that never gave up or waited for the visitor.
describe('MessageService request cost', () => {
  let service: MessageService;
  let http: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  let sockets: FakeWebSocket[];
  let hidden = false;

  class FakeWebSocket {
    static OPEN = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 1;
    sent: string[] = [];
    constructor(public url: string, public protocols?: string[]) {
      sockets.push(this);
    }
    close() { this.readyState = 3; }
    send(data: string) { this.sent.push(data); }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    (globalThis as any).WebSocket = FakeWebSocket;
    http = {
      get: vi.fn(() => of({ token: 'fresh-token' })),
      post: vi.fn(() => of(undefined)),
    };
    TestBed.configureTestingModule({
      providers: [MessageService, { provide: HttpClient, useValue: http }],
    });
    service = TestBed.inject(MessageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as any).hidden;
  });

  const latest = () => sockets[sockets.length - 1];
  const setHidden = (value: boolean) => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  describe('hub', () => {
    beforeEach(() => service.connectHub('token', '42'));

    it('takes the unread snapshot from the socket instead of fetching it', () => {
      latest().onopen?.();
      latest().onmessage?.({ data: JSON.stringify({ type: 'snapshot', unread: ['r1', 'r2'], count: 2 }) });

      expect(http.get).not.toHaveBeenCalled();
      expect(service.unreadCount$.value).toBe(2);
      expect(service.conversationUnreadState$.value.get('r2')).toBe(true);
    });

    it('waits for a hidden tab to be shown before reconnecting', () => {
      setHidden(true);
      latest().onclose?.();
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);

      setHidden(false);
      vi.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(2);
    });

    it('stops dialing after repeated failures until the visitor comes back', () => {
      for (let i = 0; i < 20; i++) {
        latest().onclose?.();
        vi.advanceTimersByTime(60_000);
      }
      expect(sockets).toHaveLength(9); // the first socket and 8 attempts

      setHidden(false);
      vi.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(10);
    });
  });

  describe('room', () => {
    beforeEach(() => service.connectRoom('room-1', 'room-token', '42'));

    it('opens the room socket on this origin with the room token as subprotocol', () => {
      expect(latest().url).toBe(`${wsOrigin}/api/chat/rooms/room-1`);
      expect(latest().protocols).toEqual(['room-token']);
    });

    it('reads history from the room\'s messages endpoint with the room token', () => {
      service.getRoomMessages('room-1', 'room-token').subscribe();
      service.getRoomMessagePage('room-1', 'room-token', 20, 123).subscribe();

      expect(http.get.mock.calls[0][0]).toBe(`${location.origin}/api/chat/rooms/room-1/messages`);
      expect(http.get.mock.calls[0][1].headers.Authorization).toBe('Bearer room-token');
      expect(http.get.mock.calls[1][0]).toBe(`${location.origin}/api/chat/rooms/room-1/messages`);
      expect(http.get.mock.calls[1][1].params.toString()).toBe('paginated=1&limit=20&before=123');
    });

    it('marks the room read over the socket when it opens', () => {
      latest().onopen?.();
      expect(latest().sent).toEqual([JSON.stringify({ type: 'read' })]);
      expect(http.post).not.toHaveBeenCalled();
    });

    it('collapses a burst of mark-reads into one socket message', () => {
      latest().onopen?.();
      latest().sent = [];
      service.markRoomRead();
      service.markRoomRead();
      service.markRoomRead();
      vi.advanceTimersByTime(1_500);

      expect(latest().sent).toEqual([JSON.stringify({ type: 'read' })]);
      expect(http.post).not.toHaveBeenCalled();
    });

    it('holds a mark-read while the tab is hidden and sends it on return', () => {
      latest().onopen?.();
      latest().sent = [];
      hidden = true;
      service.markRoomRead();
      vi.advanceTimersByTime(1_500);
      expect(latest().sent).toEqual([]);

      setHidden(false);
      expect(latest().sent).toEqual([JSON.stringify({ type: 'read' })]);
    });

    it('falls back to REST only when the socket is not open', () => {
      latest().readyState = 3;
      service.markRoomRead();
      vi.advanceTimersByTime(1_500);
      expect(http.post).toHaveBeenCalledTimes(1);
      expect(http.post.mock.calls[0][0]).toBe(`${location.origin}/api/chat/rooms/room-1/read`);
      // The room token in the header names the reader; nothing in the URL does.
      expect(http.post.mock.calls[0][2]).toEqual({ headers: { Authorization: 'Bearer room-token', 'ngsw-bypass': 'true' } });
    });
  });
});
