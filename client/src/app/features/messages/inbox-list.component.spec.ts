import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { LONG_PRESS_MS, MessagesInboxList } from './inbox-list.component';
import { I18nService } from '../../core/i18n.service';

@Component({
  standalone: true,
  imports: [MessagesInboxList],
  template: `<messages-inbox-list [chats]="chats"></messages-inbox-list>`,
})
class InboxHost {
  cdr = inject(ChangeDetectorRef);
  chats: any[] = [{ id: 'c1', other_party: 'A', other_party_role: 'seller', listing_title: 'T', latest_message: 'first' }];
}

describe('MessagesInboxList', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MessagesInboxList],
      providers: [{ provide: I18nService, useValue: { lang: () => 'en', t: (key: string) => key } }],
    });
  });

  it('shows the other party\'s school beside a name that may not be unique', () => {
    const fixture = TestBed.createComponent(MessagesInboxList);
    fixture.componentInstance.chats = [
      { id: 'c1', other_party: '周恭煥', other_party_school_name: 'North University', other_party_role: 'seller', listing_title: 'A' },
      { id: 'c2', other_party: '周恭煥', other_party_school_name: '', other_party_role: 'buyer', listing_title: 'B' },
    ];
    fixture.detectChanges();

    const partners = Array.from(fixture.nativeElement.querySelectorAll('.chat-partner')) as HTMLElement[];
    expect(partners[0].textContent).toContain('周恭煥 · North University');
    // No dangling separator when the school is unknown.
    expect(partners[1].textContent?.trim()).toBe('周恭煥');
  });

  it('shows a book cover thumbnail through the cover proxy, and a listing photo as it is', () => {
    const fixture = TestBed.createComponent(MessagesInboxList);
    fixture.componentInstance.chats = [
      { id: 'c1', other_party: 'A', other_party_role: 'seller', listing_title: 'A', listing_photo: 'https://books.google.com/books/content?id=x&img=1' },
      { id: 'c2', other_party: 'B', other_party_role: 'seller', listing_title: 'B', listing_photo: 'https://assets.unibooks.app/listings/p.jpg' },
    ];
    fixture.detectChanges();

    const thumbs = Array.from(fixture.nativeElement.querySelectorAll('img.chat-thumb')) as HTMLImageElement[];
    // A direct Google Books image is blocked by the production CSP.
    expect(thumbs[0].getAttribute('src')).toContain('/api/cover?src=');
    expect(thumbs[1].getAttribute('src')).toBe('https://assets.unibooks.app/listings/p.jpg');
  });

  it('shows a row changed in place by the page, as a live message does', () => {
    const fixture = TestBed.createComponent(InboxHost);
    fixture.detectChanges();
    const preview = () => (fixture.nativeElement.querySelector('.chat-preview') as HTMLElement).textContent?.trim();
    expect(preview()).toBe('first');

    // Messages.touchInboxRow: same array, same row object, new preview.
    fixture.componentInstance.chats[0].latest_message = 'second';
    fixture.componentInstance.chats[0]._hubUnread = true;
    fixture.componentInstance.cdr.markForCheck();
    fixture.detectChanges();

    expect(preview()).toBe('second');
    expect(fixture.nativeElement.querySelector('.unread-dot')).not.toBeNull();
  });

  describe('deleting on a phone', () => {
    const chats = () => [
      { id: 'c1', other_party: 'A', other_party_role: 'seller', listing_title: 'A' },
      { id: 'c2', other_party: 'B', other_party_role: 'buyer', listing_title: 'B' },
    ];
    function create(phone = true) {
      const fixture = TestBed.createComponent(MessagesInboxList);
      const list = fixture.componentInstance;
      list.isPhone.set(phone);
      list.chats = chats();
      fixture.detectChanges();
      const events = { opened: [] as any[], removed: [] as any[] };
      list.select.subscribe((c) => events.opened.push(c.id));
      list.remove.subscribe((c) => events.removed.push(c.id));
      return { fixture, list, events, el: fixture.nativeElement as HTMLElement };
    }
    const touch = (x: number, y = 0, pointerType = 'touch') =>
      ({ clientX: x, clientY: y, pointerType, pointerId: 1, target: document.body }) as unknown as PointerEvent;
    /** A finger dragged from x=200 by `dx`, then lifted, and the click that follows. */
    function swipe(list: MessagesInboxList, chat: any, dx: number, pointerType = 'touch') {
      list.onPointerDown(touch(200, 0, pointerType), chat);
      list.onPointerMove(touch(200 + dx / 2, 0, pointerType));
      list.onPointerMove(touch(200 + dx, 0, pointerType));
      list.onPointerUp();
      list.onRowClick(chat);
    }

    it('opens a row to its Delete with a swipe left, and deletes from there', () => {
      const { fixture, list, events, el } = create();
      swipe(list, list.chats[0], -120);
      fixture.detectChanges();

      expect(events.opened).toEqual([]);
      expect(list.offsetFor(list.chats[0])).toBe(-80);
      expect((el.querySelector('.chat-item') as HTMLElement).style.transform).toBe('translateX(-80px)');
      (el.querySelector('.swipe-delete') as HTMLElement).click();
      expect(events.removed).toEqual(['c1']);
      expect(list.openId).toBeNull();
    });

    it('springs back from a short swipe, and closes an open row instead of opening a chat', () => {
      const { list, events } = create();
      swipe(list, list.chats[0], -20);
      expect(list.openId).toBeNull();

      swipe(list, list.chats[0], -120);
      expect(list.openId).toBe('c1');
      list.onPointerDown(touch(50), list.chats[1]);
      list.onPointerUp();
      list.onRowClick(list.chats[1]);
      expect(list.openId).toBeNull();
      expect(events.opened).toEqual([]);

      list.onPointerDown(touch(50), list.chats[1]);
      list.onPointerUp();
      list.onRowClick(list.chats[1]);
      expect(events.opened).toEqual(['c2']);
    });

    it('opens a menu with Delete on a long press, without opening the chat', () => {
      vi.useFakeTimers();
      try {
        const { fixture, list, events } = create();
        list.onPointerDown(touch(100), list.chats[1]);
        vi.advanceTimersByTime(LONG_PRESS_MS);
        list.onPointerUp();
        list.onRowClick(list.chats[1]);
        fixture.detectChanges();

        expect(events.opened).toEqual([]);
        expect(list.menuChat?.id).toBe('c2');
        const action = document.querySelector('ui-bottom-sheet .sheet-action') as HTMLElement;
        expect(action.textContent).toContain('msg.deleteConversation');
        action.click();
        expect(events.removed).toEqual(['c2']);
        expect(list.menuChat).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets a scroll be a scroll: no long press once the finger moves', () => {
      vi.useFakeTimers();
      try {
        const { list } = create();
        list.onPointerDown(touch(100, 0), list.chats[0]);
        list.onPointerMove(touch(100, 30));
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(list.menuChat).toBeNull();
        expect(list.offsetFor(list.chats[0])).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves a mouse, and wide screens, to the hover × button', () => {
      const phone = create();
      swipe(phone.list, phone.list.chats[0], -120, 'mouse');
      expect(phone.list.openId).toBeNull();

      const wide = create(false);
      swipe(wide.list, wide.list.chats[0], -120);
      expect(wide.list.openId).toBeNull();
    });

    it('does not let a swipe that sent no click eat a later tap', () => {
      vi.useFakeTimers();
      try {
        const { list, events } = create();
        // Phone browsers send no click after a drag.
        list.onPointerDown(touch(200), list.chats[0]);
        list.onPointerMove(touch(190));
        list.onPointerUp();
        vi.advanceTimersByTime(1000);

        list.onPointerDown(touch(100), list.chats[1]);
        list.onPointerUp();
        list.onRowClick(list.chats[1]);
        expect(events.opened).toEqual(['c2']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('asks to delete on the first touch of Delete, once, and stops the click that would follow', () => {
      const { list, events } = create();
      swipe(list, list.chats[0], -120);
      const point = { clientX: 340, clientY: 20 };
      const preventDefault = vi.fn();
      list.onDeleteTouchStart({ touches: [point] } as unknown as TouchEvent);
      list.onDeleteTouchEnd({ changedTouches: [point], cancelable: true, preventDefault } as unknown as TouchEvent, list.chats[0]);

      expect(events.removed).toEqual(['c1']);
      expect(preventDefault).toHaveBeenCalled();
      // Should a click come anyway, it asks no second time.
      list.swipeDelete(list.chats[0]);
      expect(events.removed).toEqual(['c1']);
    });

    it('does not delete when a finger slides across Delete', () => {
      const { list, events } = create();
      swipe(list, list.chats[0], -120);
      list.onDeleteTouchStart({ touches: [{ clientX: 340, clientY: 20 }] } as unknown as TouchEvent);
      list.onDeleteTouchEnd(
        { changedTouches: [{ clientX: 340, clientY: 60 }], cancelable: true, preventDefault: vi.fn() } as unknown as TouchEvent,
        list.chats[0],
      );
      expect(events.removed).toEqual([]);
      expect(list.openId).toBe('c1');
    });

    it('does not open the chat when a long press is held well past the menu opening', () => {
      vi.useFakeTimers();
      try {
        const { list, events } = create();
        list.onPointerDown(touch(100), list.chats[0]);
        vi.advanceTimersByTime(LONG_PRESS_MS + 1500);
        list.onPointerUp();
        list.onRowClick(list.chats[0]);
        expect(events.opened).toEqual([]);
        expect(list.menuChat?.id).toBe('c1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the × for screen readers and keyboards on a phone, out of sight', () => {
      const { el } = create();
      const button = el.querySelector('.chat-delete-btn') as HTMLElement;
      expect(button.classList).toContain('sr-only');
      expect(button.getAttribute('aria-label')).toBe('msg.deleteConversation');
    });
  });
});
