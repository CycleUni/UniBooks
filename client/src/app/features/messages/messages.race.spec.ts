import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subject, of, EMPTY, throwError } from 'rxjs';
import { map } from 'rxjs/operators';
import { Messages } from './messages';
import { MessageService } from '../../core/services/message.service';
import { AuthStore } from '../../core/auth.store';
import { OrderService } from '../../core/services/order.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

// Regression test for: switching conversations quickly can display the
// wrong conversation's messages, because getChatToken()/getEdgeMessages()
// responses can resolve out of order. This test forces that exact ordering
// deterministically (no real timers/network needed) by controlling each
// request's resolution with a Subject, so it reproduces the bug reliably
// even though it's timing-dependent and hard to hit locally over a fast
// loopback connection.
describe('Messages.selectChat — out-of-order response race', () => {
  let fixture: ComponentFixture<Messages>;
  let component: Messages;

  let tokenSubjects: Record<string, Subject<{ token: string; edge_chat_url: string }>>;
  let historySubjects: Record<string, Subject<any[]>>;
  let connectEdgeChat: ReturnType<typeof vi.fn>;

  const fakeJwt = (userId: string) =>
    `header.${btoa(JSON.stringify({ user_id: userId }))}.sig`;

  beforeEach(() => {
    tokenSubjects = { A: new Subject(), B: new Subject() };
    historySubjects = { A: new Subject(), B: new Subject() };
    connectEdgeChat = vi.fn();

    const mockMessageService: Partial<Record<keyof MessageService, unknown>> = {
      getChatToken: vi.fn((id: string) => tokenSubjects[id].asObservable()),
      getEdgeMessages: vi.fn((id: string) => historySubjects[id].asObservable()),
      // Same per-conversation subjects, wrapped in the paginated envelope the
      // component actually consumes, so these tests keep driving the race
      // through `historySubjects[id].next([...])` as before.
      getEdgeMessagePage: vi.fn((id: string) =>
        historySubjects[id].asObservable().pipe(map(messages => ({ messages, has_more: false })))
      ),
      markConversationReadCF: vi.fn(() => of(undefined)),
      markRoomRead: vi.fn(),
      connectEdgeChat,
      disconnectEdgeChat: vi.fn(),
      // Unused by selectChat(), but referenced elsewhere in the component.
      roomUpdates$: EMPTY,
      roomTokenRefreshed$: EMPTY,
      conversationUnreadState$: { subscribe: () => ({ unsubscribe() {} }), value: new Map() },
      realTimeMessages$: EMPTY,
      realTimeDeletions$: EMPTY,
      realTimeAcks$: EMPTY,
      sendErrors$: EMPTY,
      connectionState$: EMPTY,
    };

    TestBed.configureTestingModule({
      imports: [Messages],
      providers: [
        { provide: MessageService, useValue: mockMessageService },
        { provide: ActivatedRoute, useValue: { queryParams: EMPTY } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: AuthStore, useValue: {} },
        { provide: OrderService, useValue: {} },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }] } },
        { provide: HttpClient, useValue: { get: vi.fn(), post: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(Messages);
    component = fixture.componentInstance;
    // Deliberately not calling fixture.detectChanges()/ngOnInit(): selectChat()
    // is self-contained and this keeps the test from needing the full
    // hub-connection subscription graph.
  });

  it('ignores a stale getChatToken/getEdgeMessages response for a conversation the user has since left', () => {
    const chatA = { id: 'A' };
    const chatB = { id: 'B' };

    // User clicks A, then quickly clicks B before A's requests resolve.
    component.selectChat(chatA);
    component.selectChat(chatB);
    expect(component.activeChat).toBe(chatB);

    // B (the currently open chat) resolves first — realistic, since it's
    // the most recent request and nothing pathological is required of it.
    tokenSubjects['B'].next({ token: fakeJwt('u_b'), edge_chat_url: 'https://edge-b.example' });
    tokenSubjects['B'].complete();
    historySubjects['B'].next([{ id: 'm_b1', content: 'hello from B', user_id: 'u_other', timestamp: 2000 }]);
    historySubjects['B'].complete();

    expect(component.chatToken).toBe(fakeJwt('u_b'));
    expect(component.edgeChatUrl).toBe('https://edge-b.example');
    expect(component.messages.map(m => m.body)).toEqual(['hello from B']);
    expect(connectEdgeChat).toHaveBeenCalledTimes(1);
    expect(connectEdgeChat).toHaveBeenLastCalledWith('B', fakeJwt('u_b'), 'u_b', 'https://edge-b.example');

    // A's slower, now-stale requests finally resolve. Without the
    // `activeChat?.id !== chat.id` guard, this next() call would overwrite
    // chatToken/edgeChatUrl/messages with A's data and re-open the socket
    // against room A — even though B is what's on screen.
    tokenSubjects['A'].next({ token: fakeJwt('u_a'), edge_chat_url: 'https://edge-a.example' });
    tokenSubjects['A'].complete();
    historySubjects['A'].next([{ id: 'm_a1', content: 'hello from A', user_id: 'u_other', timestamp: 1000 }]);
    historySubjects['A'].complete();

    // State must still reflect B, the conversation actually on screen.
    expect(component.activeChat).toBe(chatB);
    expect(component.chatToken).toBe(fakeJwt('u_b'));
    expect(component.edgeChatUrl).toBe('https://edge-b.example');
    expect(component.messages.map(m => m.body)).toEqual(['hello from B']);

    // Must not have reconnected the socket to the stale room A.
    expect(connectEdgeChat).toHaveBeenCalledTimes(1);
    expect(connectEdgeChat).not.toHaveBeenCalledWith('A', expect.anything(), expect.anything(), expect.anything());
  });

  it('still applies the response when it is not stale (single chat, normal case)', () => {
    const chatA = { id: 'A' };
    component.selectChat(chatA);

    tokenSubjects['A'].next({ token: fakeJwt('u_a'), edge_chat_url: 'https://edge-a.example' });
    tokenSubjects['A'].complete();
    historySubjects['A'].next([{ id: 'm_a1', content: 'hello from A', user_id: 'u_other', timestamp: 1000 }]);
    historySubjects['A'].complete();

    expect(component.chatToken).toBe(fakeJwt('u_a'));
    expect(component.messages.map(m => m.body)).toEqual(['hello from A']);
    expect(connectEdgeChat).toHaveBeenCalledWith('A', fakeJwt('u_a'), 'u_a', 'https://edge-a.example');
  });

  // An empty pane or inbox after a failed fetch would read as "no messages"
  // / "no conversations yet".
  describe('load failures', () => {
    it('says the history failed, instead of showing an empty chat, and retries', () => {
      const chatA = { id: 'A' };
      component.selectChat(chatA);
      tokenSubjects['A'].next({ token: fakeJwt('u_a'), edge_chat_url: 'https://edge-a.example' });
      historySubjects['A'].error(new Error('offline'));

      expect(component.historyFailed).toBe(true);
      expect(component.loadingHistory).toBe(false);

      historySubjects['A'] = new Subject();
      component.retryHistory();
      expect(component.historyFailed).toBe(false);
      expect(component.loadingHistory).toBe(true);

      historySubjects['A'].next([{ id: 'm_a1', content: 'hello', user_id: 'u_other', timestamp: 1000 }]);
      expect(component.historyFailed).toBe(false);
      expect(component.messages.map(m => m.body)).toEqual(['hello']);
    });

    it('does not carry a failed history over to the next chat opened', () => {
      component.selectChat({ id: 'A' });
      tokenSubjects['A'].next({ token: fakeJwt('u_a'), edge_chat_url: 'https://edge-a.example' });
      historySubjects['A'].error(new Error('offline'));
      expect(component.historyFailed).toBe(true);

      component.selectChat({ id: 'B' });
      expect(component.historyFailed).toBe(false);
    });

    it('marks a failed first inbox load as failed, and toasts when a refresh fails over a list', () => {
      const service = (component as any).messageService;
      const toast = { error: vi.fn() };
      (component as any).toast = toast;
      // Unsent chats come from the signed-in user's store; none here.
      (component as any).pendingChats = { list: () => [], remove: vi.fn() };

      service.getConversations = vi.fn(() => throwError(() => ({ status: 500 })));
      component.loadConversations();
      expect(component.inboxLoadFailed).toBe(true);
      expect(toast.error).not.toHaveBeenCalled();

      service.getConversations = vi.fn(() => of([{ id: 'c1', listing_id: 'l1' }]));
      component.retryInbox();
      expect(component.inboxLoadFailed).toBe(false);
      expect(component.chats.length).toBe(1);

      service.getConversations = vi.fn(() => throwError(() => ({ status: 500 })));
      component.onRefreshInbox();
      expect(component.inboxLoadFailed).toBe(false);
      expect(toast.error).toHaveBeenCalledWith('msg.inboxLoadFailed');
    });
  });
});
