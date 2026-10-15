import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, Subject, of, throwError } from 'rxjs';
import { MessageService } from './message.service';
import { SessionRefreshService } from '../session-refresh.service';

const wsOrigin = location.origin.replace(/^http/, 'ws');

/**
 * Opening the hub for a signed-in visitor. Distinct from reconnecting a hub
 * that dropped (message.service.hub-reconnect.spec.ts): here no socket has
 * ever opened, so nothing else would try again. A visitor without a hub looks
 * away to the chat server, which emails them about messages while they are on the
 * site.
 */
describe('MessageService opening the hub', () => {
  let service: MessageService;
  let sockets: FakeWebSocket[];
  /** What each SessionRefreshService.ensureAccess() answers, in turn. */
  let accessResponses: Array<() => Observable<unknown>>;
  let accessRequests: number;
  let http: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

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

  const ok = () => () => of(undefined);
  const failing = (status: number) => () => throwError(() => new HttpErrorResponse({ status }));

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    accessRequests = 0;
    accessResponses = [];
    (globalThis as any).WebSocket = FakeWebSocket;

    http = {
      get: vi.fn(() => of({ unread: [], count: 0 })),
      post: vi.fn(() => of(undefined)),
    };
    const sessionRefresh = {
      ensureAccess: vi.fn(() => {
        accessRequests++;
        const next = accessResponses.length > 1 ? accessResponses.shift()! : accessResponses[0];
        return next();
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        MessageService,
        { provide: HttpClient, useValue: http },
        { provide: SessionRefreshService, useValue: sessionRefresh },
      ],
    });
    service = TestBed.inject(MessageService);
  });

  afterEach(() => vi.useRealTimers());

  it('connects to the hub on this origin with the session cookie, at no request of its own', () => {
    accessResponses = [ok()];

    service.openHub();

    expect(sockets).toHaveLength(1);
    // The cookie names the user: no token, no subprotocol, nothing in the path.
    expect(sockets[0].url).toBe(`${wsOrigin}/api/chat/hub`);
    expect(sockets[0].protocols).toBeUndefined();
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });


  it('asks again after a transient failure and connects, rather than giving up', () => {
    // An error with no handler would be rethrown on a timer by RxJS and fail
    // this test when the clock is advanced.
    accessResponses = [failing(503), ok()];

    service.openHub();
    expect(sockets).toHaveLength(0);

    vi.advanceTimersByTime(3000);

    expect(accessRequests).toBe(2);
    expect(sockets).toHaveLength(1);
  });

  it('does not ask again when the session is over (401)', () => {
    accessResponses = [failing(401)];

    service.openHub();
    vi.advanceTimersByTime(120_000);
    service.retryHubIfOwed();

    expect(accessRequests).toBe(1);
    expect(sockets).toHaveLength(0);
  });

  it('keeps to a bounded schedule, then asks again when told to retry', () => {
    accessResponses = [failing(0)];

    service.openHub();
    vi.advanceTimersByTime(120_000);
    expect(accessRequests).toBe(4);   // first try + 3 scheduled

    accessResponses = [ok()];
    service.retryHubIfOwed();

    expect(accessRequests).toBe(5);
    expect(sockets).toHaveLength(1);
  });

  it('does not retry an answer that waiting would not change', () => {
    accessResponses = [failing(404)];

    service.openHub();
    vi.advanceTimersByTime(120_000);
    service.retryHubIfOwed();

    expect(accessRequests).toBe(1);
  });

  it('never has two session checks out at once', () => {
    const pending = new Subject<unknown>();
    accessResponses = [() => pending];

    service.openHub();
    service.openHub();
    service.retryHubIfOwed();

    expect(accessRequests).toBe(1);
  });

  it('does not check the session again for a hub that is already open', () => {
    accessResponses = [ok()];
    service.openHub();

    service.openHub();

    expect(accessRequests).toBe(1);
    expect(sockets).toHaveLength(1);
  });

  it('stops trying once the visitor signs out, and ignores a refresh that settles late', () => {
    const pending = new Subject<unknown>();
    accessResponses = [failing(503), () => pending];

    service.openHub();
    vi.advanceTimersByTime(3000);          // the retry goes out and waits
    service.closeHub();
    pending.next(undefined);
    vi.advanceTimersByTime(120_000);
    service.retryHubIfOwed();

    expect(accessRequests).toBe(2);
    expect(sockets).toHaveLength(0);
  });

  it('gives the next sign-in a full schedule of its own', () => {
    accessResponses = [failing(503)];
    service.openHub();
    vi.advanceTimersByTime(3000);          // first session is one retry in
    service.closeHub();

    const before = accessRequests;
    service.openHub();
    vi.advanceTimersByTime(120_000);

    expect(accessRequests - before).toBe(4);
  });
});
