import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { MessageService } from './message.service';

// A hub token is valid for two hours. Reconnecting with the cached copy of it
// therefore stops working on any tab left open longer than that: every retry
// 401s, the hub stays down, and CFEdgeChat — which decides who is "away" by
// whether their hub has a socket — starts emailing the user about messages
// arriving in the page they are currently looking at.
describe('MessageService hub reconnect', () => {
  let service: MessageService;
  let http: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  let sockets: FakeWebSocket[];

  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 1;
    constructor(public url: string, public protocols?: string[]) {
      sockets.push(this);
    }
    close() { this.readyState = 3; }
    send() {}
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    (globalThis as any).WebSocket = FakeWebSocket;

    http = {
      // The hub snapshot fetched on open, and the fresh hub token below, are
      // the only two calls this test's paths make.
      get: vi.fn((url: string) =>
        url.includes('/messaging/hub-token/')
          ? of({ token: 'fresh-token', edge_chat_url: 'https://edge.example' })
          : of({ unread: [], lastReadAt: {}, count: 0 })
      ),
      post: vi.fn(() => of(undefined)),
    };

    TestBed.configureTestingModule({
      providers: [MessageService, { provide: HttpClient, useValue: http }],
    });
    service = TestBed.inject(MessageService);
    service.connectHub('stale-token', '42', 'https://edge.example');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function dropTheConnection() {
    sockets[sockets.length - 1].onclose?.();
    vi.advanceTimersByTime(60_000);
  }

  it('mints a fresh token instead of replaying the expired one', () => {
    expect(sockets[0].protocols).toEqual(['stale-token']);

    dropTheConnection();

    expect(http.get).toHaveBeenCalledWith('/messaging/hub-token/');
    expect(sockets).toHaveLength(2);
    expect(sockets[1].protocols).toEqual(['fresh-token']);
  });

  it('falls back to the cached token when the token request itself fails', () => {
    // Backend unreachable is the common case here (the network dropped, which
    // is why the socket closed) — retry with what we have rather than giving
    // up on the hub until the next page load.
    // What HttpClient actually reports when the request never reached a
    // server: an HttpErrorResponse with status 0.
    http.get.mockImplementation((url: string) =>
      url.includes('/messaging/hub-token/')
        ? throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' }))
        : of({ unread: [], lastReadAt: {}, count: 0 })
    );

    dropTheConnection();

    expect(sockets).toHaveLength(2);
    expect(sockets[1].protocols).toEqual(['stale-token']);
  });

  const tokenResponse = (respond: (url: string) => unknown) =>
    http.get.mockImplementation((url: string) =>
      url.includes('/messaging/hub-token/') ? respond(url) : of({ unread: [], lastReadAt: {}, count: 0 })
    );

  it.each([401, 403])('stops reconnecting once the session is gone (hub-token %i)', (status) => {
    // AuthInterceptor has already tried to refresh by the time a 401 reaches
    // here, and cleared the session. Falling back to the cached token made a
    // signed-out tab call the backend every two seconds, forever.
    tokenResponse(() => throwError(() => new HttpErrorResponse({ status })));

    dropTheConnection();
    vi.advanceTimersByTime(10 * 60_000);

    const tokenCalls = http.get.mock.calls.filter(([url]) => String(url).includes('/messaging/hub-token/'));
    expect(tokenCalls).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it('stops reconnecting on a failure that is not an HTTP response at all', () => {
    // A signed-out tab's token request now fails with a 401 (covered above).
    // Anything that is not an HttpErrorResponse says nothing about the backend
    // being briefly unavailable either, so it must not start a retry loop.
    tokenResponse(() => throwError(() => new Error('not an HTTP failure')));

    dropTheConnection();
    vi.advanceTimersByTime(10 * 60_000);

    expect(sockets).toHaveLength(1);
  });

  it.each([429, 503])('keeps retrying through a transient backend failure (%i)', (status) => {
    tokenResponse(() => throwError(() => new HttpErrorResponse({ status })));

    dropTheConnection();

    expect(sockets).toHaveLength(2);
    expect(sockets[1].protocols).toEqual(['stale-token']);
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

  it('does not reopen a hub that was disconnected while the token request was in flight', () => {
    // Sign-out calls disconnectHub; a token response arriving afterwards used
    // to open the hub again behind the layout's back.
    const pending = new Subject<{ token: string; edge_chat_url: string }>();
    tokenResponse(() => pending);

    sockets[0].onclose?.();
    vi.advanceTimersByTime(1_000);
    service.disconnectHub();
    pending.next({ token: 'fresh-token', edge_chat_url: 'https://edge.example' });
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
  });

  it('leaves alone a connection opened while the token request was in flight', () => {
    // Sign out and straight back in as the same user: the layout opens a fresh
    // connection (retry count 0) before the old reconnect's token arrives.
    // The late reconnect must neither open a second socket nor disturb the
    // fresh connection's retry count, or its next drop would wait longer.
    const pending = new Subject<{ token: string; edge_chat_url: string }>();
    tokenResponse(() => pending);

    sockets[0].onclose?.();
    vi.advanceTimersByTime(1_000);
    service.connectHub('new-login-token', '42', 'https://edge.example');
    pending.next({ token: 'late-token', edge_chat_url: 'https://edge.example' });
    expect(sockets).toHaveLength(2);

    tokenResponse(() => of({ token: 'fresh-token', edge_chat_url: 'https://edge.example' }));
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
