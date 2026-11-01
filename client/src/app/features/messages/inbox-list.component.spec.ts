import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { MessagesInboxList } from './inbox-list.component';
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

  describe('edit mode on a phone', () => {
    const chats = () => [
      { id: 'c1', other_party: 'A', other_party_role: 'seller', listing_title: 'A' },
      { id: 'c2', other_party: 'B', other_party_role: 'buyer', listing_title: 'B' },
      { id: 'c3', other_party: 'C', other_party_role: 'buyer', listing_title: 'C' },
    ];
    function create(phone = true) {
      const fixture = TestBed.createComponent(MessagesInboxList);
      const list = fixture.componentInstance;
      list.isPhone.set(phone);
      list.chats = chats();
      fixture.detectChanges();
      return { fixture, list, el: fixture.nativeElement as HTMLElement };
    }
    const rows = (el: HTMLElement) => Array.from(el.querySelectorAll('.chat-item')) as HTMLElement[];

    it('offers Edit only on a phone, where the rows have no hover delete', () => {
      expect(create(false).el.querySelector('.edit-btn')).toBeNull();
      expect(create(true).el.querySelector('.edit-btn')?.getAttribute('aria-label')).toBe('common.edit');
    });

    it('ticks rows instead of opening them, and hands the ticked ones over to delete', () => {
      const { fixture, list, el } = create();
      const opened: any[] = [];
      const removed: any[][] = [];
      const editing: boolean[] = [];
      list.select.subscribe((c) => opened.push(c));
      list.removeMany.subscribe((c) => removed.push(c));
      list.editingChange.subscribe((e) => editing.push(e));

      (el.querySelector('.edit-btn') as HTMLElement).click();
      fixture.detectChanges();
      expect(editing).toEqual([true]);
      expect(el.querySelector('.chat-delete-btn')).toBeNull();
      expect(el.querySelector('.edit-btn')?.getAttribute('aria-label')).toBe('common.cancel');
      const button = () => el.querySelector('.delete-btn') as HTMLButtonElement;
      expect(button().disabled).toBe(true);

      rows(el)[0].click();
      rows(el)[2].click();
      fixture.detectChanges();
      expect(opened).toEqual([]);
      expect(rows(el)[0].getAttribute('aria-checked')).toBe('true');
      expect(rows(el)[1].getAttribute('aria-checked')).toBe('false');

      button().click();
      expect(removed.map((r) => r.map((c) => c.id))).toEqual([['c1', 'c3']]);
    });

    it('selects all and none', () => {
      const { fixture, list, el } = create();
      list.setEditing(true);
      fixture.detectChanges();
      const selectAll = () => el.querySelector('.select-all-btn') as HTMLButtonElement;

      selectAll().click();
      fixture.detectChanges();
      expect(list.selectedIds.size).toBe(3);
      expect(selectAll().getAttribute('aria-label')).toBe('msg.deselectAll');

      selectAll().click();
      expect(list.selectedIds.size).toBe(0);
    });

    it('ends editing once the selected conversations are gone, keeping one that failed ticked', () => {
      const { fixture, list } = create();
      const editing: boolean[] = [];
      list.editingChange.subscribe((e) => editing.push(e));
      list.setEditing(true);
      list.toggle({ id: 'c1' });
      list.toggle({ id: 'c2' });

      // c1 deleted, c2 failed.
      fixture.componentRef.setInput('chats', chats().filter((c) => c.id !== 'c1'));
      fixture.detectChanges();
      expect(list.editing).toBe(true);
      expect([...list.selectedIds]).toEqual(['c2']);

      fixture.componentRef.setInput('chats', chats().filter((c) => c.id === 'c3'));
      fixture.detectChanges();
      expect(list.editing).toBe(false);
      expect(editing).toEqual([true, false]);
    });

    it('leaves edit mode when the layout stops being a phone, or the list goes', () => {
      const { fixture, list } = create();
      const editing: boolean[] = [];
      list.editingChange.subscribe((e) => editing.push(e));
      list.setEditing(true);
      list.isPhone.set(false);
      fixture.detectChanges();
      expect(list.editing).toBe(false);

      list.isPhone.set(true);
      list.setEditing(true);
      fixture.destroy();
      expect(editing).toEqual([true, false, true, false]);
    });
  });
});
