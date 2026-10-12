import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { Location } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, Subject, of, throwError } from 'rxjs';
import { Messages } from './messages';
import { MessageService } from '../../core/services/message.service';
import { AuthStore } from '../../core/auth.store';
import { OrderService } from '../../core/services/order.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { ListingService } from '../../core/services/listing.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { PendingChatStore, pendingChatFromListing, pendingChatId } from './pending-chats';

// Contacting a seller used to create the conversation straight away, so the
// seller's inbox filled with conversations the buyer never wrote in. The chat
// now stays in the buyer's browser until its first message.
describe('Messages pending chats', () => {
  let fixture: ComponentFixture<Messages>;
  let component: Messages;
  let queryParams: BehaviorSubject<Params>;
  let router: { navigate: ReturnType<typeof vi.fn> };
  let messageService: any;
  let connectionState: Subject<string>;
  let getListing: ReturnType<typeof vi.fn>;
  let toast: { error: ReturnType<typeof vi.fn> };
  let user: { id: number } | null;

  const listing = {
    id: 'listing-1', seller: 7, seller_name: 'Seller', school_name: 'NTU', book_title: 'Calculus',
    photos: [], book_cover_url: 'cover.jpg', price: 300, condition: 'new', course_name: '',
  };

  function setup(initialParams: Params = {}, conversations: any[] = [], beforeInit: () => void = () => {}) {
    queryParams = new BehaviorSubject<Params>(initialParams);
    router = { navigate: vi.fn() };
    connectionState = new Subject<string>();
    getListing = vi.fn(() => of(listing));
    toast = { error: vi.fn() };
    messageService = {
      getConversations: vi.fn(() => of(conversations)),
      startConversation: vi.fn(() => of({ id: 'conv-new', listing_id: 'listing-1', other_party: 'Seller' })),
      getChatToken: vi.fn(() => of({ token: 'header.eyJ1c2VyX2lkIjoiMSJ9.sig', edge_chat_url: 'https://edge.example' })),
      getEdgeMessagePage: vi.fn(() => of({ messages: [], has_more: false })),
      deleteConversation: vi.fn(() => of({ status: 'hidden' })),
      sendEdgeMessage: vi.fn(() => true),
      markRoomRead: vi.fn(),
      connectEdgeChat: vi.fn(),
      disconnectEdgeChat: vi.fn(),
      roomUpdates$: EMPTY,
      roomTokenRefreshed$: EMPTY,
      conversationUnreadState$: new BehaviorSubject(new Map()),
      realTimeMessages$: EMPTY,
      realTimeDeletions$: EMPTY,
      realTimeAcks$: EMPTY,
      sendErrors$: EMPTY,
      connectionState$: connectionState,
    };

    TestBed.configureTestingModule({
      imports: [Messages],
      providers: [
        { provide: MessageService, useValue: messageService },
        { provide: ActivatedRoute, useValue: { queryParams } },
        { provide: Router, useValue: router },
        { provide: Location, useValue: { back: vi.fn() } },
        { provide: AuthStore, useValue: { user: () => user } },
        { provide: OrderService, useValue: {} },
        { provide: ListingService, useValue: { getListing } },
        { provide: ToastService, useValue: toast },
        { provide: ConfirmService, useValue: { askDanger: vi.fn(async () => true) } },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'en' } },
        { provide: RegionService, useValue: { currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }] } },
        { provide: HttpClient, useValue: { get: vi.fn(), post: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(Messages);
    component = fixture.componentInstance;
    beforeInit();
    component.ngOnInit();
  }

  /** What Router.navigate would do to the query params, for these tests. */
  function applyLastNavigation() {
    const [, extras] = router.navigate.mock.calls.at(-1)!;
    queryParams.next({ ...extras.queryParams });
  }

  const stored = () => TestBed.inject(PendingChatStore).list();
  /** A chat left unsent earlier in this page's life. */
  const keepPending = () => TestBed.inject(PendingChatStore).save(pendingChatFromListing(listing));

  beforeEach(() => {
    user = { id: 1 };
    localStorage.clear();
  });

  it('opens a chat for a listing without creating a conversation', () => {
    setup({ listing: 'listing-1' });

    expect(messageService.startConversation).not.toHaveBeenCalled();
    expect(getListing).toHaveBeenCalledWith('listing-1');
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
      queryParams: { chat: pendingChatId('listing-1') },
    }));
    expect(stored().map((c: any) => c.id)).toEqual([pendingChatId('listing-1')]);

    applyLastNavigation();
    expect(component.activeChat.pending).toBe(true);
    expect(component.activeChat.listing_title).toBe('Calculus');
    // No room to open for it yet.
    expect(messageService.getChatToken).not.toHaveBeenCalled();
  });

  it('keeps an unsent chat in the inbox while the page stays open', () => {
    setup({}, [{ id: 'conv-A', listing_id: 'other' }], keepPending);

    expect(component.chats.map(c => c.id)).toEqual([pendingChatId('listing-1'), 'conv-A']);
  });

  it('drops an unsent chat once its conversation exists', () => {
    setup({}, [{ id: 'conv-A', listing_id: 'listing-1' }], keepPending);

    expect(component.chats.map(c => c.id)).toEqual(['conv-A']);
    expect(stored()).toEqual([]);
  });

  it('does not show one account’s unsent chats to another', () => {
    setup({}, [], () => { keepPending(); user = { id: 2 }; });

    expect(component.chats).toEqual([]);
  });

  it('forgets unsent chats kept by earlier versions in localStorage', () => {
    localStorage.setItem('unibooks.chat.pending.tw.1', JSON.stringify([pendingChatFromListing(listing)]));
    setup();

    expect(component.chats).toEqual([]);
    expect(localStorage.getItem('unibooks.chat.pending.tw.1')).toBeNull();
  });

  it('rebuilds an unsent chat from its URL after a reload', () => {
    setup({ chat: pendingChatId('listing-1') });

    expect(getListing).toHaveBeenCalledWith('listing-1');
    // The URL already names it: navigating there again would not re-emit.
    expect(router.navigate).not.toHaveBeenCalled();
    expect(component.activeChat.id).toBe(pendingChatId('listing-1'));
  });

  it.each(['removed', 'sold'])('will not open a chat on a listing that is %s', (status) => {
    setup({ listing: 'listing-1' }, [], () => getListing.mockReturnValue(of({ ...listing, status })));

    expect(toast.error).toHaveBeenCalledWith('msg.errListingUnavailable');
    expect(component.chats).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('drops the unsent chat when the listing was taken down before the first message', () => {
    setup({ listing: 'listing-1' });
    applyLastNavigation();
    messageService.startConversation.mockReturnValue(
      throwError(() => ({ status: 409, error: { error: { code: 'msg.errListingUnavailable' } } })),
    );

    component.newMessage = 'Is this still available?';
    component.sendMessage();

    expect(toast.error).toHaveBeenCalledWith('msg.errListingUnavailable');
    expect(component.chats).toEqual([]);
    expect(component.activeChat).toBeNull();
    expect(stored()).toEqual([]);
  });

  it('creates the conversation with the first message and sends it once the room is open', () => {
    setup({ listing: 'listing-1' });
    applyLastNavigation();

    component.newMessage = 'Is this still available?';
    component.sendMessage();

    expect(messageService.startConversation).toHaveBeenCalledWith('listing-1');
    expect(component.activeChat.id).toBe('conv-new');
    expect(component.chats.map(c => c.id)).toEqual(['conv-new']);
    expect(stored()).toEqual([]);
    expect(router.navigate).toHaveBeenLastCalledWith([], expect.objectContaining({
      queryParams: { chat: 'conv-new' }, replaceUrl: true,
    }));
    // Shown straight away, sent when the new room's socket is up.
    expect(component.messages.map(m => m.body)).toEqual(['Is this still available?']);
    expect(messageService.sendEdgeMessage).not.toHaveBeenCalled();

    connectionState.next('connected');
    expect(messageService.sendEdgeMessage).toHaveBeenCalledWith('Is this still available?', 'text', undefined);
  });

  it('leaves nothing on the server when the unsent chat is deleted', async () => {
    setup({ listing: 'listing-1' });
    applyLastNavigation();

    await component.deleteConversation(component.activeChat);

    expect(messageService.deleteConversation).not.toHaveBeenCalled();
    expect(component.chats).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('refuses a chat with yourself', () => {
    user = { id: 7 };
    setup({ listing: 'listing-1' });

    expect(toast.error).toHaveBeenCalledWith('msg.cannotMessageSelf');
    expect(component.chats).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('shows placeholders while a conversation’s history loads', () => {
    setup({}, [{ id: 'conv-A', listing_id: 'other' }]);
    const history = new Subject<any>();
    messageService.getEdgeMessagePage.mockReturnValue(history);

    component.openChat(component.chats[0]);
    expect(component.loadingHistory).toBe(true);

    history.next({ messages: [], has_more: false });
    expect(component.loadingHistory).toBe(false);
  });
});

describe('PendingChatStore', () => {
  it('keeps chats per user and region', () => {
    let region = 'tw';
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthStore, useValue: { user: () => ({ id: 1 }) } },
        { provide: RegionService, useValue: { region: () => region } },
      ],
    });
    const store = TestBed.inject(PendingChatStore);

    store.save({ id: pendingChatId('a') });
    expect(store.list().map(c => c.id)).toEqual([pendingChatId('a')]);

    region = 'hk';
    expect(store.list()).toEqual([]);
  });
});
