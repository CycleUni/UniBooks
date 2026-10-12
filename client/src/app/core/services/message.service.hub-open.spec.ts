import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, Subject, of, throwError } from 'rxjs';
import { MessageService } from './message.service';

/**
 * Opening the hub for a signed-in visitor. Distinct from reconnecting a hub
 * that dropped (message.service.hub-reconnect.spec.ts): here no socket has
 * ever opened, so nothing else would try again. A visitor without a hub looks
 * away to CFEdgeChat, which emails them about messages while they are on the
 * site.
 */
describe('MessageService opening the hub', () => {
  let service: MessageService;
  let sockets: FakeWebSocket[];
  let tokenResponses: Array<() => Observable<unknown>>;
  let tokenRequests: number;

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

  const hubToken = (uid: string) => `h.${btoa(JSON.stringify({ user_id: uid }))}.s`;
  const ok = (uid = '42') => () => of({ token: hubToken(uid), edge_chat_url: 'https://edge.example' });
  const failing = (status: number) => () => throwError(() => new HttpErrorResponse({ status }));

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    tokenRequests = 0;
    tokenResponses = [];
    (globalThis as any).WebSocket = FakeWebSocket;

    const http = {
      get: vi.fn((url: string) => {
        if (!url.includes('/messaging/hub-token/')) return of({ unread: [], lastReadAt: {}, count: 0 });
        tokenRequests++;
        const next = tokenResponses.length > 1 ? tokenResponses.shift()! : tokenResponses[0];
        return next();
      }),
      post: vi.fn(() => of(undefined)),
    };
    TestBed.configureTestingModule({
      providers: [MessageService, { provide: HttpClient, useValue: http }],
    });
    service = TestBed.inject(MessageService);
  });

  afterEach(() => vi.useRealTimers());

  it('fetches a hub token and connects to the hub at edge_chat_url', () => {
    tokenResponses = [ok('42')];

    service.openHub();

    expect(sockets).toHaveLength(1);
    // The token names the user (and is the subprotocol); the path does not.
    expect(sockets[0].url).toBe('wss://edge.example/api/chat/hub');
    expect(sockets[0].protocols).toEqual([hubToken('42')]);
  });

  it('builds a plain ws: hub URL for a local http origin', () => {
    tokenResponses = [() => of({ token: hubToken('42'), edge_chat_url: 'http://localhost:4200' })];

    service.openHub();

    expect(sockets[0].url).toBe('ws://localhost:4200/api/chat/hub');
  });

  it('asks again after a transient failure and connects, rather than giving up', () => {
    // An error with no handler would be rethrown on a timer by RxJS and fail
    // this test when the clock is advanced.
    tokenResponses = [failing(503), ok('42')];

    service.openHub();
    expect(sockets).toHaveLength(0);

    vi.advanceTimersByTime(3000);

    expect(tokenRequests).toBe(2);
    expect(sockets).toHaveLength(1);
  });

  it('does not ask again when the session is over (401)', () => {
    tokenResponses = [failing(401)];

    service.openHub();
    vi.advanceTimersByTime(120_000);
    service.retryHubIfOwed();

    expect(tokenRequests).toBe(1);
    expect(sockets).toHaveLength(0);
  });

  it('keeps to a bounded schedule, then asks again when told to retry', () => {
    tokenResponses = [failing(0)];

    service.openHub();
    vi.advanceTimersByTime(120_000);
    expect(tokenRequests).toBe(4);   // first try + 3 scheduled

    tokenResponses = [ok('42')];
    service.retryHubIfOwed();

    expect(tokenRequests).toBe(5);
    expect(sockets).toHaveLength(1);
  });

  it('does not retry an answer that waiting would not change', () => {
    tokenResponses = [failing(404)];

    service.openHub();
    vi.advanceTimersByTime(120_000);
    service.retryHubIfOwed();

    expect(tokenRequests).toBe(1);
  });

  it('never has two token requests out at once', () => {
    const pending = new Subject<unknown>();
    tokenResponses = [() => pending];

    service.openHub();
    service.openHub();
    service.retryHubIfOwed();

    expect(tokenRequests).toBe(1);
  });

  it('does not fetch a token for a hub that is already open', () => {
    tokenResponses = [ok('42')];
    service.openHub();

    service.openHub();

    expect(tokenRequests).toBe(1);
    expect(sockets).toHaveLength(1);
  });

  it('stops trying once the visitor signs out, and ignores a token that arrives late', () => {
    const pending = new Subject<unknown>();
    tokenResponses = [failing(503), () => pending];

    service.openHub();
    vi.advanceTimersByTime(3000);          // the retry goes out and waits
    service.closeHub();
    pending.next({ token: hubToken('42'), edge_chat_url: 'https://edge.example' });
    vi.advanceTimersByTime(120_000);
    service.retryHubIfOwed();

    expect(tokenRequests).toBe(2);
    expect(sockets).toHaveLength(0);
  });

  it('gives the next sign-in a full schedule of its own', () => {
    tokenResponses = [failing(503)];
    service.openHub();
    vi.advanceTimersByTime(3000);          // first session is one retry in
    service.closeHub();

    const before = tokenRequests;
    service.openHub();
    vi.advanceTimersByTime(120_000);

    expect(tokenRequests - before).toBe(4);
  });
});
