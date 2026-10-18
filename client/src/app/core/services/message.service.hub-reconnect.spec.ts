import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, Subject, of, throwError } from 'rxjs';
import { MessageService } from './message.service';
import { SessionRefreshService } from '../session-refresh.service';

// The hub signs in with the access cookie, which lapses after 15 minutes. A
// reconnect after that has to refresh the session first, or every retry is
// refused, the hub stays down, and the chat server — which decides who is
// "away" by whether their hub has a socket — starts emailing the user about
// messages arriving in the page they are currently looking at.
describe('MessageService hub reconnect', () => {
  let service: MessageService;
  let http: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  let ensureAccess: ReturnType<typeof vi.fn>;
  let sockets: FakeWebSocket[];

  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 1;
    constructor(
      public url: string,
      public protocols?: string[],
    ) {
      sockets.push(this);
    }
    close() {
      this.readyState = 3;
    }
    send() {}
  }

  const accessResponse = (respond: () => Observable<unknown>) =>
    ensureAccess.mockImplementation(respond);

  beforeEach(() => {
    vi.useFakeTimers();
    // Full schedule: the jitter only ever shortens a delay, and these pin the schedule itself.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    sockets = [];
    (globalThis as any).WebSocket = FakeWebSocket;

    http = {
      get: vi.fn(() => of({ unread: [], count: 0 })),
      post: vi.fn(() => of(undefined)),
    };
    // A live access cookie unless a test says otherwise.
    ensureAccess = vi.fn(() => of(undefined));

    TestBed.configureTestingModule({
      providers: [
        MessageService,
        { provide: HttpClient, useValue: http },
        { provide: SessionRefreshService, useValue: { ensureAccess } },
      ],
    });
    service = TestBed.inject(MessageService);
    service.connectHub();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function dropTheConnection() {
    sockets[sockets.length - 1].onclose?.();
    vi.advanceTimersByTime(60_000);
  }

  it('makes sure of a live session before reconnecting, with no request of its own', () => {
    dropTheConnection();

    expect(ensureAccess).toHaveBeenCalledTimes(1);
    expect(http.get).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].protocols).toBeUndefined();
  });

  it('reconnects anyway when the refresh could not reach the backend', () => {
    // Backend unreachable is the common case here (the network dropped, which
    // is why the socket closed) — retry rather than giving up on the hub
    // until the next page load. What HttpClient reports when the request
    // never reached a server: an HttpErrorResponse with status 0.
    accessResponse(() =>
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })),
    );

    dropTheConnection();

    expect(sockets).toHaveLength(2);
  });

  it.each([401, 403])('stops reconnecting once the session is gone (%i)', (status) => {
    // The refresh was refused (and SessionRefreshService ended the session).
    // Reconnecting anyway made a signed-out tab call the backend every two
    // seconds, forever.
    accessResponse(() => throwError(() => new HttpErrorResponse({ status })));

    dropTheConnection();
    vi.advanceTimersByTime(10 * 60_000);

    expect(ensureAccess).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it('stops reconnecting on a failure that is not an HTTP response at all', () => {
    // Anything that is not an HttpErrorResponse says nothing about the backend
    // being briefly unavailable either, so it must not start a retry loop.
    accessResponse(() => throwError(() => new Error('not an HTTP failure')));

    dropTheConnection();
    vi.advanceTimersByTime(10 * 60_000);

    expect(sockets).toHaveLength(1);
  });

  it.each([429, 503])('keeps retrying through a transient backend failure (%i)', (status) => {
    accessResponse(() => throwError(() => new HttpErrorResponse({ status })));

    dropTheConnection();

    expect(sockets).toHaveLength(2);
  });

  it('backs off between repeated failures instead of retrying every second', () => {
    // connectHub resets the retry count, so the reconnect path used to start
    // over at a one-second delay on every attempt.
    const closeLatest = () => sockets[sockets.length - 1].onclose?.();

    closeLatest();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);

    closeLatest();
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2); // a second failure waits 2s, not 1s
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    closeLatest();
    vi.advanceTimersByTime(3_999);
    expect(sockets).toHaveLength(3); // and a third waits 4s
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it('starts the backoff over once a reconnect has stayed up', () => {
    const closeLatest = () => sockets[sockets.length - 1].onclose?.();
    closeLatest();
    vi.advanceTimersByTime(1_000);
    closeLatest();
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(3);

    sockets[2].onopen?.();
    vi.advanceTimersByTime(30_000);
    closeLatest();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(4);
  });

  it('keeps backing off when a connection opens and drops straight away', () => {
    // Resetting on open made an open-then-1006 loop retry every second.
    const closeLatest = () => sockets[sockets.length - 1].onclose?.();
    closeLatest();
    vi.advanceTimersByTime(1_000);
    closeLatest();
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(3);

    sockets[2].onopen?.();
    closeLatest();
    vi.advanceTimersByTime(3_999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it('does not reopen a hub that was disconnected while the refresh was in flight', () => {
    // Sign-out calls disconnectHub; a refresh settling afterwards must not
    // open the hub again behind the layout's back.
    const pending = new Subject<void>();
    accessResponse(() => pending);

    sockets[0].onclose?.();
    vi.advanceTimersByTime(1_000);
    service.disconnectHub();
    pending.next();
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
  });

  it('leaves alone a connection opened while the refresh was in flight', () => {
    // Sign out and straight back in: the layout opens a fresh connection
    // (retry count 0) before the old reconnect's refresh settles. The late
    // reconnect must neither open a second socket nor disturb the fresh
    // connection's retry count, or its next drop would wait longer.
    const pending = new Subject<void>();
    accessResponse(() => pending);

    sockets[0].onclose?.();
    vi.advanceTimersByTime(1_000);
    service.disconnectHub();
    service.connectHub();
    pending.next();
    expect(sockets).toHaveLength(2);

    accessResponse(() => of(undefined));
    sockets[1].onclose?.();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);
  });

  it('does not reconnect after an intentional disconnect', () => {
    service.disconnectHub();
    sockets[sockets.length - 1].onclose?.();
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
  });
});
