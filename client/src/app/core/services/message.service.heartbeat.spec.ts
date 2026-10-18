import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { MessageService } from './message.service';
import { SessionRefreshService } from '../session-refresh.service';

// A socket that sleeps through a laptop lid or a network change keeps
// reporting OPEN and never fires onclose, so nothing reconnected and the chat
// went deaf. The heartbeat is what notices.
describe('MessageService heartbeat', () => {
  let service: MessageService;
  let sockets: FakeWebSocket[];

  class FakeWebSocket {
    static OPEN = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
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
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    sockets = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    TestBed.configureTestingModule({
      providers: [
        MessageService,
        { provide: HttpClient, useValue: { get: vi.fn(() => of({ token: 'fresh-token' })), post: vi.fn(() => of(undefined)) } },
        { provide: SessionRefreshService, useValue: { ensureAccess: () => of(undefined) } },
      ],
    });
    service = TestBed.inject(MessageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as any).hidden;
  });

  const latest = () => sockets[sockets.length - 1];

  it('keeps a socket that answers the ping', () => {
    service.connectRoom('room-1', 'room-token', '42');
    latest().onopen?.();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(25_000);
      latest().onmessage?.({ data: 'pong' });
    }
    expect(latest().sent.filter(m => m === 'ping')).toHaveLength(4);
    expect(sockets).toHaveLength(1);
  });

  it('drops a silent socket and reconnects it', () => {
    service.connectRoom('room-1', 'room-token', '42');
    latest().onopen?.();
    vi.advanceTimersByTime(25_000 + 8_000);
    expect(sockets[0].readyState).toBe(3);
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
  });

  it('tells the open conversation to catch up once the room is back', () => {
    const back = vi.fn();
    service.roomReconnected$.subscribe(back);
    service.connectRoom('room-1', 'room-token', '42');
    latest().onopen?.();
    expect(back).not.toHaveBeenCalled();

    latest().onclose?.();
    vi.advanceTimersByTime(1_000);
    latest().onopen?.();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('drops a silent hub socket too', () => {
    service.connectHub();
    latest().onopen?.();
    vi.advanceTimersByTime(25_000 + 8_000 + 2_000);
    expect(sockets).toHaveLength(2);
  });

  it('checks a socket right away when the visitor comes back', () => {
    service.connectRoom('room-1', 'room-token', '42');
    latest().onopen?.();
    window.dispatchEvent(new Event('focus'));
    expect(latest().sent).toContain('ping');
    vi.advanceTimersByTime(5_000 + 2_000);
    // (>= : services from earlier tests still listen on window and redial too)
    expect(sockets[0].readyState).toBe(3);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it('stops redialing the room after repeated failures until the visitor comes back', () => {
    service.connectRoom('room-1', 'room-token', '42');
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new Event('keydown')); // using the page, not idle
      latest().onclose?.();
      vi.advanceTimersByTime(60_000);
    }
    expect(sockets).toHaveLength(9); // the first socket and 8 attempts

    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(2_000);
    expect(sockets.length).toBeGreaterThanOrEqual(10);
  });

  it('does not redial while the page is idle, and does as soon as the visitor acts', () => {
    service.connectRoom('room-1', 'room-token', '42');
    latest().onopen?.();
    // Left alone: the open socket stays (pongs keep it up), nothing is cut.
    for (let i = 0; i < 24; i++) {
      vi.advanceTimersByTime(25_000);
      latest().onmessage?.({ data: 'pong' });
    }
    expect(sockets).toHaveLength(1);

    // It drops while nobody is there: held, not dialed.
    latest().onclose?.();
    vi.advanceTimersByTime(5 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(service.roomGaveUp$.value).toBe(true);

    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(2_000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps redialing for a visitor who is using the page', () => {
    service.connectRoom('room-1', 'room-token', '42');
    latest().onopen?.();
    latest().onclose?.();
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new Event('keydown'));
      vi.advanceTimersByTime(5 * 60_000);
    }
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it('reconnects at once when asked, even after giving up', () => {
    service.connectRoom('room-1', 'room-token', '42');
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new Event('keydown')); // using the page, not idle
      latest().onclose?.();
      vi.advanceTimersByTime(60_000);
    }
    const before = sockets.length;
    latest().onclose?.();
    service.reconnectNow();
    vi.advanceTimersByTime(1_000);
    expect(sockets.length).toBe(before + 1);
  });
});

describe('MessageService reconnect spread', () => {
  afterEach(() => vi.restoreAllMocks());

  it('spreads clients that drop together across the backoff window', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    TestBed.configureTestingModule({
      providers: [
        MessageService,
        { provide: HttpClient, useValue: { get: vi.fn(), post: vi.fn() } },
        { provide: SessionRefreshService, useValue: { ensureAccess: () => of(undefined) } },
      ],
    });
    const service = TestBed.inject(MessageService) as any;
    service.currentRoomId = 'r';
    service.scheduleReconnect();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 500);
    vi.useRealTimers();
  });
});

describe('MessageService gave-up state', () => {
  it('is raised once automatic reconnecting stops, and cleared by a reconnect', () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    const created: any[] = [];
    (globalThis as any).WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      onopen: any; onclose: any; onmessage: any;
      constructor() { created.push(this); }
      close() { this.readyState = 3; }
      send() {}
    };
    TestBed.configureTestingModule({
      providers: [
        MessageService,
        { provide: HttpClient, useValue: { get: vi.fn(() => of({ token: 't' })), post: vi.fn(() => of(undefined)) } },
        { provide: SessionRefreshService, useValue: { ensureAccess: () => of(undefined) } },
      ],
    });
    const service = TestBed.inject(MessageService);
    service.connectRoom('room-1', 'room-token', '42');
    expect(service.roomGaveUp$.value).toBe(false);
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new Event('keydown')); // using the page, not idle
      created[created.length - 1].onclose?.();
      vi.advanceTimersByTime(60_000);
    }
    expect(service.roomGaveUp$.value).toBe(true);

    service.reconnectNow();
    expect(service.roomGaveUp$.value).toBe(false);
    vi.useRealTimers();
    delete (document as any).hidden;
  });
});
