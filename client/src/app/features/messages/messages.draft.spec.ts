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

describe('Messages draft persistence', () => {
  let fixture: ComponentFixture<Messages>;
  let component: Messages;
  let mockMessageService: any;

  beforeEach(() => {
    sessionStorage.clear();

    mockMessageService = {
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
      realTimeMessages$: EMPTY,
      realTimeDeletions$: EMPTY,
      realTimeAcks$: EMPTY,
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
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('persists unsent draft when switching conversations and restores on return', () => {
    const chatA = { id: 'conv-A' };
    const chatB = { id: 'conv-B' };

    // Select Chat A and type a draft
    component.selectChat(chatA);
    expect(component.newMessage).toBe('');
    component.newMessage = 'Draft for Conversation A';
    component.onDraftChange('Draft for Conversation A');

    // Switch to Chat B
    component.selectChat(chatB);
    expect(component.newMessage).toBe(''); // Chat B has no draft yet
    component.newMessage = 'Draft for Conversation B';
    component.onDraftChange('Draft for Conversation B');

    // Switch back to Chat A
    component.selectChat(chatA);
    expect(component.newMessage).toBe('Draft for Conversation A');

    // Switch back to Chat B
    component.selectChat(chatB);
    expect(component.newMessage).toBe('Draft for Conversation B');
  });

  it('clears draft from storage upon successfully sending message', () => {
    const chatA = { id: 'conv-A' };
    component.selectChat(chatA);
    component.connectionState = 'connected';
    component.newMessage = 'Hello seller!';
    component.onDraftChange('Hello seller!');

    expect(sessionStorage.getItem('unibooks.chat.draft.conv-A')).toBe('Hello seller!');

    component.sendMessage();

    expect(component.newMessage).toBe('');
    expect(sessionStorage.getItem('unibooks.chat.draft.conv-A')).toBeNull();
  });

  it('caps draft size to prevent quota exhaustion', () => {
    const chatA = { id: 'conv-A' };
    component.selectChat(chatA);
    const hugeText = 'A'.repeat(5000);
    component.newMessage = hugeText;
    component.onDraftChange(hugeText);

    const saved = sessionStorage.getItem('unibooks.chat.draft.conv-A');
    expect(saved?.length).toBe(2000);
  });
});
