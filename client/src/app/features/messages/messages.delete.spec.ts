import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subject, of, EMPTY } from 'rxjs';
import { Messages } from './messages';
import { MessageService } from '../../core/services/message.service';
import { AuthStore } from '../../core/auth.store';
import { OrderService } from '../../core/services/order.service';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { Component, ChangeDetectorRef } from '@angular/core';

describe('Messages - Delete Single Message', () => {
  let fixture: ComponentFixture<Messages>;
  let component: Messages;
  let mockMessageService: any;
  let mockConfirmService: any;

  beforeEach(() => {
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
      deleteEdgeMessage: vi.fn(),
      roomUpdates$: EMPTY,
      roomTokenRefreshed$: EMPTY,
      conversationUnreadState$: { subscribe: () => ({ unsubscribe() {} }), value: new Map() },
      realTimeMessages$: EMPTY,
      realTimeDeletions$: EMPTY,
      realTimeAcks$: EMPTY,
      sendErrors$: EMPTY,
      connectionState$: of('connected'),
    };

    mockConfirmService = {
      askDanger: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [Messages],
      providers: [
        { provide: MessageService, useValue: mockMessageService },
        { provide: ConfirmService, useValue: mockConfirmService },
        { provide: ActivatedRoute, useValue: { queryParams: EMPTY } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: AuthStore, useValue: { user: () => ({ id: 'user-1' }) } },
        { provide: OrderService, useValue: {} },
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'zh-TW' } },
        { provide: RegionService, useValue: { currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }] } },
        { provide: HttpClient, useValue: { get: vi.fn(), post: vi.fn() } },
        { provide: ChangeDetectorRef, useValue: { markForCheck: vi.fn(), detectChanges: vi.fn() } }
      ],
    });

    fixture = TestBed.createComponent(Messages);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('asks for confirmation before deleting a sent message and deletes if confirmed', async () => {
    component.messages = [{ id: 'msg-1', body: 'hello' }];
    mockConfirmService.askDanger.mockResolvedValue(true);

    await component.deleteMessage('msg-1');

    expect(mockConfirmService.askDanger).toHaveBeenCalled();
    expect(component.messages.length).toBe(0);
    expect(mockMessageService.deleteEdgeMessage).toHaveBeenCalledWith('msg-1');
  });

  it('does not delete the message if confirmation is cancelled', async () => {
    component.messages = [{ id: 'msg-1', body: 'hello' }];
    mockConfirmService.askDanger.mockResolvedValue(false);

    await component.deleteMessage('msg-1');

    expect(mockConfirmService.askDanger).toHaveBeenCalled();
    expect(component.messages.length).toBe(1);
    expect(mockMessageService.deleteEdgeMessage).not.toHaveBeenCalled();
  });

  it('bypasses confirmation for pending/temp messages and deletes locally only', async () => {
    component.messages = [{ id: 'temp_123', body: 'hello' }];
    
    await component.deleteMessage('temp_123');

    expect(mockConfirmService.askDanger).not.toHaveBeenCalled();
    expect(component.messages.length).toBe(0);
    expect(mockMessageService.deleteEdgeMessage).not.toHaveBeenCalled();
  });
});
