import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { Location } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subject, of, EMPTY } from 'rxjs';
import { Messages } from './messages';
import { MessageService, RoomUpdate } from '../../core/services/message.service';
import { AuthStore } from '../../core/auth.store';
import { OrderService } from '../../core/services/order.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

// Selecting a conversation used to leave the URL alone, so a refresh dropped
// back to the bare inbox and a conversation could not be linked to. The page
// already honoured `?chat=<id>` on the way in; these pin that it now writes
// it on the way out, and that browser Back closes a chat opened from the
// inbox (on a phone, the only way back to the list without the header button).
describe('Messages ?chat= URL sync', () => {
  let fixture: ComponentFixture<Messages>;
  let component: Messages;
  let queryParams: BehaviorSubject<Params>;
  let router: { navigate: ReturnType<typeof vi.fn> };
  let location: { back: ReturnType<typeof vi.fn> };
  let messageService: any;
  let roomUpdates: Subject<RoomUpdate>;

  const chats = () => [
    { id: 'conv-A', latest_message: 'old A', updated_at: '2026-09-01T00:00:00Z' },
    { id: 'conv-B', latest_message: 'old B', updated_at: '2026-08-01T00:00:00Z' },
  ];

  function setup(initialParams: Params = {}) {
    queryParams = new BehaviorSubject<Params>(initialParams);
    router = { navigate: vi.fn() };
    location = { back: vi.fn() };
    roomUpdates = new Subject<RoomUpdate>();
    messageService = {
      getConversations: vi.fn(() => of(chats())),
      getChatToken: vi.fn(() => of({ token: 'header.eyJ1c2VyX2lkIjoidXNlci0xIn0.sig', edge_chat_url: 'https://edge.example' })),
      getEdgeMessagePage: vi.fn(() => of({ messages: [], has_more: false })),
      markConversationReadCF: vi.fn(() => of(undefined)),
      markRoomRead: vi.fn(),
      connectEdgeChat: vi.fn(),
      disconnectEdgeChat: vi.fn(),
      roomUpdates$: roomUpdates,
      roomTokenRefreshed$: EMPTY,
      conversationUnreadState$: new BehaviorSubject(new Map()),
      realTimeMessages$: EMPTY,
      realTimeDeletions$: EMPTY,
      realTimeAcks$: EMPTY,
      sendErrors$: EMPTY,
      connectionState$: EMPTY,
    };

    TestBed.configureTestingModule({
      imports: [Messages],
      providers: [
        { provide: MessageService, useValue: messageService },
        { provide: ActivatedRoute, useValue: { queryParams } },
        { provide: Router, useValue: router },
        { provide: Location, useValue: location },
        { provide: AuthStore, useValue: { user: () => null } },
        { provide: OrderService, useValue: {} },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }] } },
        { provide: HttpClient, useValue: { get: vi.fn(), post: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(Messages);
    component = fixture.componentInstance;
    // ngOnInit without rendering: the subscriptions are what's under test.
    component.ngOnInit();
  }

  /** What Router.navigate would do to the query params, for these tests. */
  function applyLastNavigation() {
    const [, extras] = router.navigate.mock.calls.at(-1)!;
    const next = { ...extras.queryParams };
    for (const key of Object.keys(next)) if (next[key] == null) delete next[key];
    queryParams.next(next);
  }

  it('pushes ?chat=<id> when a chat is opened from the inbox, without re-fetching it', () => {
    setup();
    const chatA = component.chats[0];

    component.openChat(chatA);

    expect(component.activeChat).toBe(chatA);
    expect(router.navigate).toHaveBeenCalledWith([], expect.objectContaining({
      queryParams: { chat: 'conv-A' },
      replaceUrl: false,
    }));

    // The navigation comes back through the queryParams subscription.
    applyLastNavigation();
    expect(messageService.getChatToken).toHaveBeenCalledTimes(1);
  });

  it('replaces the entry when switching between open chats', () => {
    setup();
    component.openChat(component.chats[0]);
    applyLastNavigation();

    component.openChat(component.chats[1]);

    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
      queryParams: { chat: 'conv-B' },
      replaceUrl: true,
    }));
  });

  it('closes the chat when browser Back removes ?chat=', () => {
    setup();
    component.openChat(component.chats[0]);
    applyLastNavigation();

    queryParams.next({}); // popstate

    expect(component.activeChat).toBeNull();
  });

  it('the header back button pops the entry it pushed', () => {
    setup();
    component.openChat(component.chats[0]);
    applyLastNavigation();
    router.navigate.mockClear();

    component.closeChat();

    expect(component.activeChat).toBeNull();
    expect(location.back).toHaveBeenCalledTimes(1);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('a chat arrived at by link is closed by replacing the URL, not by leaving the page', () => {
    setup({ chat: 'conv-B' });
    expect(component.activeChat?.id).toBe('conv-B');

    component.closeChat();

    expect(location.back).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
      queryParams: { chat: null },
      replaceUrl: true,
    }));
  });

  it('moves a conversation with a new message to the top with its preview and time', () => {
    setup();
    roomUpdates.next({ room_id: 'conv-B', sender_id: 'u2', preview: 'new in B', timestamp: Date.UTC(2026, 8, 14, 15, 23) });

    expect(component.chats.map(c => c.id)).toEqual(['conv-B', 'conv-A']);
    expect(component.chats[0].latest_message).toBe('new in B');
    expect(component.chats[0].updated_at).toBe('2026-09-14T15:23:00.000Z');
  });

  it('reloads conversations on pull-to-refresh (onRefreshInbox)', () => {
    setup();
    expect(messageService.getConversations).toHaveBeenCalledTimes(1);

    component.onRefreshInbox();

    expect(messageService.getConversations).toHaveBeenCalledTimes(2);
    expect(component.refreshingInbox).toBe(false);
  });
});
