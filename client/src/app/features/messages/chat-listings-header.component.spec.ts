import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChatListingsHeaderComponent, ChatListingItem } from './chat-listings-header.component';
import { I18nService } from '../../core/i18n.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { RegionService } from '../../core/region.service';

describe('ChatListingsHeaderComponent', () => {
  let confirmMock: { askDanger: ReturnType<typeof vi.fn> };

  const sampleListings: ChatListingItem[] = [
    {
      ref: 'ref-1',
      id: 'listing-1',
      title: 'Calculus I',
      isbn: '9780000000001',
      price: 350,
      status: 'active',
      cover_url: 'https://example.com/cover1.jpg',
      is_available: true,
    },
    {
      ref: 'ref-2',
      id: 'listing-2',
      title: 'Physics II',
      isbn: '9780000000002',
      price: 420,
      status: 'active',
      cover_url: '',
      is_available: true,
    },
    {
      ref: 'ref-3',
      id: null,
      title: 'Deleted Book',
      isbn: '9780000000003',
      price: null,
      status: 'removed',
      cover_url: '',
      is_available: false,
    },
  ];

  beforeEach(() => {
    confirmMock = { askDanger: vi.fn(async () => true) };

    TestBed.configureTestingModule({
      imports: [ChatListingsHeaderComponent],
      providers: [
        {
          provide: I18nService,
          useValue: {
            t: (key: string, params?: any) => key,
            lang: () => 'en',
          },
        },
        { provide: ConfirmService, useValue: confirmMock },
        {
          provide: RegionService,
          useValue: {
            currency: () => ({ code: 'TWD', decimal_places: 0 }),
            region: () => 'tw',
            regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }],
          },
        },
      ],
    });
  });

  it('renders all listing chips and their details', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentInstance.listings = sampleListings;
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const chips = el.querySelectorAll('.listing-chip');
    expect(chips.length).toBe(3);

    const titles = Array.from(el.querySelectorAll('.chip-title')).map((t) => t.textContent?.trim());
    expect(titles).toEqual(['Calculus I', 'Physics II', 'Deleted Book']);

    expect(chips[2].classList.contains('unavailable')).toBe(true);
    expect(el.querySelector('.badge.danger')?.textContent).toContain('msg.statusRemoved');
  });

  it('emits goListing when clicking an available chip', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentInstance.listings = sampleListings;
    fixture.detectChanges();

    const goListingSpy = vi.fn();
    fixture.componentInstance.goListing.subscribe(goListingSpy);

    const buttons = fixture.nativeElement.querySelectorAll('.chip-content') as NodeListOf<HTMLButtonElement>;
    buttons[0].click();

    expect(goListingSpy).toHaveBeenCalledWith('ref-1');
  });

  it('disables chip click when listing is unavailable', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentInstance.listings = sampleListings;
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.chip-content') as NodeListOf<HTMLButtonElement>;
    expect(buttons[2].disabled).toBe(true);
  });

  it('shows add-book button and remove buttons only for buyer when listings > 1', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentRef.setInput('listings', sampleListings);
    fixture.componentRef.setInput('isBuyer', false);
    fixture.detectChanges();

    let el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.add-book-chip')).toBeNull();
    expect(el.querySelectorAll('.chip-remove-btn').length).toBe(0);

    // Switch to buyer
    fixture.componentRef.setInput('isBuyer', true);
    fixture.detectChanges();

    el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.add-book-chip')).not.toBeNull();
    expect(el.querySelectorAll('.chip-remove-btn').length).toBe(3);
  });

  it('does not show remove buttons for buyer when only 1 listing', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentRef.setInput('listings', [sampleListings[0]]);
    fixture.componentRef.setInput('isBuyer', true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.chip-remove-btn').length).toBe(0);
    expect(el.querySelector('.add-book-chip')).not.toBeNull();
  });

  it('emits openPicker when add-book chip is clicked', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentInstance.listings = sampleListings;
    fixture.componentInstance.isBuyer = true;
    fixture.detectChanges();

    const openPickerSpy = vi.fn();
    fixture.componentInstance.openPicker.subscribe(openPickerSpy);

    const addBtn = fixture.nativeElement.querySelector('.add-book-chip') as HTMLButtonElement;
    addBtn.click();

    expect(openPickerSpy).toHaveBeenCalled();
  });

  it('confirms and emits removeListing when remove button is clicked', async () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentInstance.listings = sampleListings;
    fixture.componentInstance.isBuyer = true;
    fixture.detectChanges();

    const removeSpy = vi.fn();
    fixture.componentInstance.removeListing.subscribe(removeSpy);

    const removeBtns = fixture.nativeElement.querySelectorAll('.chip-remove-btn') as NodeListOf<HTMLButtonElement>;
    removeBtns[0].click();

    expect(confirmMock.askDanger).toHaveBeenCalled();
    await fixture.whenStable();
    expect(removeSpy).toHaveBeenCalledWith(sampleListings[0]);
  });

  it('does not emit removeListing when confirmation is cancelled', async () => {
    confirmMock.askDanger.mockResolvedValueOnce(false);
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentInstance.listings = sampleListings;
    fixture.componentInstance.isBuyer = true;
    fixture.detectChanges();

    const removeSpy = vi.fn();
    fixture.componentInstance.removeListing.subscribe(removeSpy);

    const removeBtns = fixture.nativeElement.querySelectorAll('.chip-remove-btn') as NodeListOf<HTMLButtonElement>;
    removeBtns[0].click();

    await fixture.whenStable();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('shows viewOrder button when hasOrder is true and emits on click', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentRef.setInput('listings', sampleListings);
    fixture.componentRef.setInput('hasOrder', true);
    fixture.detectChanges();

    const viewOrderSpy = vi.fn();
    fixture.componentInstance.viewOrder.subscribe(viewOrderSpy);

    const el = fixture.nativeElement as HTMLElement;
    const viewBtn = el.querySelector('.header-actions ui-button button') as HTMLElement;
    expect(viewBtn).not.toBeNull();

    viewBtn.click();
    expect(viewOrderSpy).toHaveBeenCalled();
  });

  it('getSelectedListings filters out unavailable listings', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentInstance.listings = sampleListings;

    const selected = fixture.componentInstance.getSelectedListings();
    expect(selected.length).toBe(2);
    expect(selected.map((s) => s.ref)).toEqual(['ref-1', 'ref-2']);
  });

  it('renders checkboxes for available listings and emits startOrder on order button click', () => {
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentRef.setInput('listings', sampleListings);
    fixture.componentRef.setInput('isBuyer', true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const checkboxes = el.querySelectorAll<HTMLInputElement>('.chip-checkbox');
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(true);

    const startOrderSpy = vi.fn();
    fixture.componentInstance.startOrder.subscribe(startOrderSpy);

    const orderBtn = el.querySelector('.header-actions ui-button button') as HTMLElement;
    expect(orderBtn).not.toBeNull();
    orderBtn.click();
    expect(startOrderSpy).toHaveBeenCalledWith(['listing-1', 'listing-2']);

    // Uncheck first item
    checkboxes[0].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedCount).toBe(1);

    orderBtn.click();
    expect(startOrderSpy).toHaveBeenCalledWith(['listing-2']);
  });

  it('displays specific reasons for sold and reserved items', () => {
    const mixedListings: ChatListingItem[] = [
      { ref: 'r1', id: '1', title: 'Sold', isbn: '1', price: 100, status: 'sold', cover_url: '', is_available: false },
      { ref: 'r2', id: '2', title: 'Reserved', isbn: '2', price: 200, status: 'reserved', cover_url: '', is_available: false },
      { ref: 'r3', id: '3', title: 'Removed', isbn: '3', price: 300, status: 'removed', cover_url: '', is_available: false },
    ];
    const fixture = TestBed.createComponent(ChatListingsHeaderComponent);
    fixture.componentRef.setInput('listings', mixedListings);
    fixture.detectChanges();

    const badges = fixture.nativeElement.querySelectorAll('.badge.danger');
    expect(badges[0].textContent).toContain('msg.statusSold');
    expect(badges[1].textContent).toContain('msg.statusReserved');
    expect(badges[2].textContent).toContain('msg.statusRemoved');
  });
});
