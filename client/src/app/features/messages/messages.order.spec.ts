import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subject, of, EMPTY } from 'rxjs';
import { Messages } from './messages';
import { MessageService } from '../../core/services/message.service';
import { AuthStore } from '../../core/auth.store';
import { OrderService } from '../../core/services/order.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

describe('Messages WebSocket ordering & temp-id reconciliation', () => {
  let fixture: ComponentFixture<Messages>;
  let component: Messages;
  let realTimeMessagesSubject: Subject<any>;
  let realTimeAcksSubject: Subject<any>;
  let mockMessageService: any;

  beforeEach(() => {
    realTimeMessagesSubject = new Subject();
    realTimeAcksSubject = new Subject();

    mockMessageService = {
      getConversations: vi.fn(() => of([])),
      getChatToken: vi.fn(() => of({ token: 'header.eyJ1c2VyX2lkIjoidXNlci0xIn0.sig', edge_chat_url: 'https://edge.example' })),
      getEdgeMessages: vi.fn(() => of([])),
      getEdgeMessagePage: vi.fn(() => of({ messages: [], has_more: false })),
      markConversationReadCF: vi.fn(() => of(undefined)),
      markRoomRead: vi.fn(),
      connectEdgeChat: vi.fn(),
      disconnectEdgeChat: vi.fn(),
      sendEdgeMessage: vi.fn(() => true),
      roomUpdates$: EMPTY,
      roomTokenRefreshed$: EMPTY,
      conversationUnreadState$: { subscribe: () => ({ unsubscribe() {} }), value: new Map() },
      realTimeMessages$: realTimeMessagesSubject.asObservable(),
      realTimeDeletions$: EMPTY,
      realTimeAcks$: realTimeAcksSubject.asObservable(),
      sendErrors$: EMPTY,
      connectionState$: of('connected'),
    };

    TestBed.configureTestingModule({
      imports: [Messages],
      providers: [
        { provide: MessageService, useValue: mockMessageService },
        { provide: ActivatedRoute, useValue: { queryParams: EMPTY } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: AuthStore, useValue: { user: () => ({ id: 'user-1' }) } },
        { provide: OrderService, useValue: {} },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'zh-TW' } },
        { provide: RegionService, useValue: { currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }] } },
        { provide: HttpClient, useValue: { get: vi.fn(), post: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(Messages);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('inserts out-of-order WebSocket messages into correct chronological order', () => {
    const chat = { id: 'conv-1' };
    component.selectChat(chat);
    component.userId = 'user-1';

    // Message 3 arrives first (timestamp 3000)
    realTimeMessagesSubject.next({
      id: 'msg-3',
      content: 'Third message',
      user_id: 'user-2',
      timestamp: 3000
    });

    // Message 1 arrives second (timestamp 1000)
    realTimeMessagesSubject.next({
      id: 'msg-1',
      content: 'First message',
      user_id: 'user-2',
      timestamp: 1000
    });

    // Message 2 arrives third (timestamp 2000)
    realTimeMessagesSubject.next({
      id: 'msg-2',
      content: 'Second message',
      user_id: 'user-2',
      timestamp: 2000
    });

    expect(component.messages.map(m => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(component.messages.map(m => m.body)).toEqual(['First message', 'Second message', 'Third message']);
  });

  it('reconciles optimistic temp ID with server ack while maintaining order', () => {
    const chat = { id: 'conv-1' };
    component.selectChat(chat);
    component.userId = 'user-1';
    component.connectionState = 'connected';

    // Send an optimistic message
    component.newMessage = 'Optimistic hello';
    component.sendMessage();

    expect(component.messages.length).toBe(1);
    const tempId = component.messages[0].id;
    expect(tempId.startsWith('temp_')).toBe(true);

    // Server acks with real ID and timestamp
    realTimeAcksSubject.next({
      id: 'server-id-123',
      timestamp: 5000
    });

    expect(component.messages.length).toBe(1);
    expect(component.messages[0].id).toBe('server-id-123');
    expect(component.messages[0].body).toBe('Optimistic hello');
  });

  describe('accepting a meetup from the chat card', () => {
    let updateOrderStatus: ReturnType<typeof vi.fn>;
    let ask: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      updateOrderStatus = vi.fn(() => of({}));
      ask = vi.fn();
      (component as any).orderService = { updateOrderStatus };
      (component as any).meetupDetails = { ask };
      component.activeChat = { id: 'c1', order_id: 'o1', listing_title: 'Calculus' } as any;
    });

    it('asks for the meetup time and place, like the orders list does', async () => {
      ask.mockResolvedValue({ time: '2026-10-01 15:00', location: 'Library' });
      await component.handleAcceptMeetup();
      expect(ask).toHaveBeenCalledWith('Calculus');
      expect(updateOrderStatus).toHaveBeenCalledWith('o1', 'accepted', undefined, '2026-10-01 15:00', 'Library');
    });

    it('does not accept when the form is closed', async () => {
      ask.mockResolvedValue(null);
      await component.handleAcceptMeetup();
      expect(updateOrderStatus).not.toHaveBeenCalled();
    });

    it('keeps the accepted details for the card', async () => {
      ask.mockResolvedValue({ time: '2026-10-01T15:00', location: 'Library' });
      updateOrderStatus.mockReturnValue(of({ meetup_time: '2026-10-01T15:00:00+08:00', meetup_location: 'Library' }));
      await component.handleAcceptMeetup();
      expect(component.activeChat.order_meetup_time).toBe('2026-10-01T15:00:00+08:00');
      expect(component.activeChat.order_meetup_location).toBe('Library');
    });
  });

  describe('the agreed meetup on the chat card', () => {
    const accept = { id: 'm1', body: '[SYSTEM:order.notify.seller_approved] System Notification' };
    const update = { id: 'm2', body: '[SYSTEM:order.notify.meetup_updated] System Notification' };
    const text = { id: 'm3', body: 'see you there' };

    beforeEach(() => {
      component.activeChat = {
        id: 'c1', order_id: 'o1', order_status: 'accepted', other_party_role: 'buyer', listing_title: 'Calculus',
        order_meetup_time: '2026-10-01T15:00:00+08:00', order_meetup_location: 'Library',
      } as any;
    });

    it('shows on the latest accept or update card only', () => {
      component.messages = [accept, update, text] as any;
      expect(component.showsMeetupDetails(accept)).toBe(false);
      expect(component.showsMeetupDetails(update)).toBe(true);
      expect(component.showsMeetupDetails(text)).toBe(false);
    });

    it('is editable by the seller until the handover', () => {
      component.messages = [accept] as any;
      expect(component.canEditMeetup(accept)).toBe(true);

      component.activeChat.order_status = 'handed_over';
      expect(component.showsMeetupDetails(accept)).toBe(true);
      expect(component.canEditMeetup(accept)).toBe(false);

      component.activeChat.order_status = 'cancelled';
      expect(component.showsMeetupDetails(accept)).toBe(false);
    });

    it('is not editable by the buyer', () => {
      component.messages = [accept] as any;
      component.activeChat.other_party_role = 'seller';
      expect(component.canEditMeetup(accept)).toBe(false);
    });

    it('edits start from the agreed details and save the new ones', async () => {
      const updateMeetupDetails = vi.fn(() => of({ meetup_time: '2026-10-02T18:00:00+08:00', meetup_location: 'Gate' }));
      const ask = vi.fn(async () => ({ time: '2026-10-02T18:00', location: 'Gate' }));
      (component as any).orderService = { updateMeetupDetails };
      (component as any).meetupDetails = { ask };

      await component.handleEditMeetup();

      expect(ask).toHaveBeenCalledWith('Calculus', { time: '2026-10-01T15:00:00+08:00', location: 'Library' });
      expect(updateMeetupDetails).toHaveBeenCalledWith('o1', '2026-10-02T18:00', 'Gate');
      expect(component.activeChat.order_meetup_location).toBe('Gate');
    });
  });
});
