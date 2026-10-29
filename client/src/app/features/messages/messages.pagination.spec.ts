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
  let getRoomMessagePage: ReturnType<typeof vi.fn>;

  const row = (id: string, timestamp: number) => ({
    id, content: `msg ${id}`, user_id: 'u_other', timestamp
  });

  beforeEach(() => {
    getRoomMessagePage = vi.fn(() => of({ messages: [], has_more: false }));

    const mockMessageService: Partial<Record<keyof MessageService, unknown>> = {
      getChatToken: vi.fn(() => EMPTY),
      getRoomMessages: vi.fn(() => of([])),
      getRoomMessagePage,
      postRoomRead: vi.fn(() => of(undefined)),
      markRoomRead: vi.fn(),
      connectRoom: vi.fn(),
      disconnectRoom: vi.fn(),
      roomUpdates$: EMPTY,
      roomTokenRefreshed$: EMPTY,
      roomReconnected$: EMPTY,
      roomGaveUp$: EMPTY,
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
        { provide: AuthStore, useValue: { user: () => null } },
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
    component.hasMoreHistory = hasMore;
    (component as any).setEdgeMessages(messages);
  }

  it('requests the page older than the oldest message held', () => {
    seedLoaded([row('m2', 2000), row('m3', 3000)], true);
    getRoomMessagePage.mockClear();
    getRoomMessagePage.mockReturnValue(of({ messages: [row('m1', 1000)], has_more: false }));

    (component as any).loadOlderMessages();

    expect(getRoomMessagePage).toHaveBeenCalledTimes(1);
    // ...args: roomId, token, url, limit, before
    expect(getRoomMessagePage.mock.calls[0][3]).toBe(2000);
  });

  it('prepends the older page ahead of what is already shown', () => {
    seedLoaded([row('m2', 2000), row('m3', 3000)], true);
    getRoomMessagePage.mockReturnValue(of({ messages: [row('m1', 1000)], has_more: false }));

    (component as any).loadOlderMessages();

    expect(component.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('stops offering more once the server says there are none left', () => {
    seedLoaded([row('m2', 2000)], true);
    getRoomMessagePage.mockReturnValue(of({ messages: [row('m1', 1000)], has_more: false }));

    (component as any).loadOlderMessages();
    expect(component.hasMoreHistory).toBe(false);

    // A further scroll must not fire another request.
    getRoomMessagePage.mockClear();
    (component as any).loadOlderMessages();
    expect(getRoomMessagePage).not.toHaveBeenCalled();
  });

  it('does not fire a second request while one is in flight', () => {
    seedLoaded([row('m2', 2000)], true);
    getRoomMessagePage.mockClear();
    getRoomMessagePage.mockReturnValue(EMPTY); // never resolves

    (component as any).loadOlderMessages();
    (component as any).loadOlderMessages();

    expect(getRoomMessagePage).toHaveBeenCalledTimes(1);
  });

  it('drops a page that arrives after the user switched conversations', () => {
    seedLoaded([row('m2', 2000)], true);
    getRoomMessagePage.mockImplementation(() => {
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
    getRoomMessagePage.mockClear();
    getRoomMessagePage.mockReturnValue(of({ messages: [], has_more: false }));

    (component as any).loadOlderMessages();

    expect(getRoomMessagePage.mock.calls[0][3]).toBe(2000);
  });
});
