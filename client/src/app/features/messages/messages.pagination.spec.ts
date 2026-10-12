import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { of, EMPTY } from 'rxjs';
import { Messages } from './messages';
import { MessageService } from '../../core/services/message.service';
import { AuthStore } from '../../core/auth.store';
import { OrderService } from '../../core/services/order.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';

// History loads a page at a time, with older pages fetched as the user
// scrolls back up. These cover the cursor/guard logic around that.
describe('Messages — history pagination', () => {
  let fixture: ComponentFixture<Messages>;
  let component: Messages;
  let getEdgeMessagePage: ReturnType<typeof vi.fn>;

  const row = (id: string, timestamp: number) => ({
    id, content: `msg ${id}`, user_id: 'u_other', timestamp
  });

  beforeEach(() => {
    getEdgeMessagePage = vi.fn(() => of({ messages: [], has_more: false }));

    const mockMessageService: Partial<Record<keyof MessageService, unknown>> = {
      getChatToken: vi.fn(() => EMPTY),
      getEdgeMessages: vi.fn(() => of([])),
      getEdgeMessagePage,
      markConversationReadCF: vi.fn(() => of(undefined)),
      markRoomRead: vi.fn(),
      connectEdgeChat: vi.fn(),
      disconnectEdgeChat: vi.fn(),
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
  });

  /** Puts the component in the state it reaches after an initial page load. */
  function seedLoaded(messages: any[], hasMore: boolean) {
    component.activeChat = { id: 'A' };
    component.chatToken = 'tok';
    component.edgeChatUrl = 'https://edge.example';
    component.hasMoreHistory = hasMore;
    (component as any).setEdgeMessages(messages);
  }

  it('requests the page older than the oldest message held', () => {
    seedLoaded([row('m2', 2000), row('m3', 3000)], true);
    getEdgeMessagePage.mockClear();
    getEdgeMessagePage.mockReturnValue(of({ messages: [row('m1', 1000)], has_more: false }));

    (component as any).loadOlderMessages();

    expect(getEdgeMessagePage).toHaveBeenCalledTimes(1);
    // ...args: roomId, token, url, limit, before
    expect(getEdgeMessagePage.mock.calls[0][4]).toBe(2000);
  });

  it('prepends the older page ahead of what is already shown', () => {
    seedLoaded([row('m2', 2000), row('m3', 3000)], true);
    getEdgeMessagePage.mockReturnValue(of({ messages: [row('m1', 1000)], has_more: false }));

    (component as any).loadOlderMessages();

    expect(component.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('stops offering more once the server says there are none left', () => {
    seedLoaded([row('m2', 2000)], true);
    getEdgeMessagePage.mockReturnValue(of({ messages: [row('m1', 1000)], has_more: false }));

    (component as any).loadOlderMessages();
    expect(component.hasMoreHistory).toBe(false);

    // A further scroll must not fire another request.
    getEdgeMessagePage.mockClear();
    (component as any).loadOlderMessages();
    expect(getEdgeMessagePage).not.toHaveBeenCalled();
  });

  it('does not fire a second request while one is in flight', () => {
    seedLoaded([row('m2', 2000)], true);
    getEdgeMessagePage.mockClear();
    getEdgeMessagePage.mockReturnValue(EMPTY); // never resolves

    (component as any).loadOlderMessages();
    (component as any).loadOlderMessages();

    expect(getEdgeMessagePage).toHaveBeenCalledTimes(1);
  });

  it('drops a page that arrives after the user switched conversations', () => {
    seedLoaded([row('m2', 2000)], true);
    getEdgeMessagePage.mockImplementation(() => {
      // Simulate the switch happening while the request is in flight.
      component.activeChat = { id: 'B' };
      return of({ messages: [row('m1', 1000)], has_more: true });
    });

    (component as any).loadOlderMessages();

    expect(component.messages.map(m => m.id)).toEqual(['m2']);
  });

  it('renders history even if the worker still returns a bare array', () => {
    // Frontend deployed ahead of the worker: no envelope, no `has_more`.
    component.activeChat = { id: 'A' };
    (component as any).setEdgeMessages([row('m1', 1000), row('m2', 2000)]);

    expect(component.messages.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('ignores optimistic sends when picking the cursor', () => {
    seedLoaded([row('m2', 2000)], true);
    // An in-flight send carries a local timestamp older than nothing real.
    component.messages.unshift({
      id: 'temp_1', body: 'sending', is_mine: true,
      created_at: new Date(500).toISOString(), message_type: 'text'
    } as any);
    getEdgeMessagePage.mockClear();
    getEdgeMessagePage.mockReturnValue(of({ messages: [], has_more: false }));

    (component as any).loadOlderMessages();

    expect(getEdgeMessagePage.mock.calls[0][4]).toBe(2000);
  });
});
