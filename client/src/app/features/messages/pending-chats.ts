import { Injectable, inject } from '@angular/core';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';

/**
 * Chats a buyer has opened with a seller but not yet written in.
 *
 * Contacting a seller used to create the conversation at once, so every tap
 * of "Contact seller" left the seller an empty conversation in their inbox,
 * whether or not the buyer went on to say anything. Now the chat lives only
 * here, in this browser, until its first message: sending it creates the
 * conversation (Messages.sendMessage) and removes it from here.
 *
 * Kept in memory only, per user and region: the inbox is per region, and a
 * shared browser must not show one account's unsent chats to another. They
 * were kept in localStorage, and an unsent chat then sat in the inbox for
 * days — long after the seller had taken the listing down, leaving a row of
 * broken cover photos. Closing or reloading the page now drops them; reopening
 * one by its URL rebuilds it from the listing, which is checked afresh.
 */

/** Ids of pending chats; never a conversation id, which is a bare UUID. */
export const PENDING_CHAT_PREFIX = 'pending-';

export function pendingChatId(listingId: string | number): string {
  return `${PENDING_CHAT_PREFIX}${listingId}`;
}

export function isPendingChat(chat: { id?: unknown } | null | undefined): boolean {
  return typeof chat?.id === 'string' && chat.id.startsWith(PENDING_CHAT_PREFIX);
}

/**
 * A pending chat for a listing, in the shape the inbox and the chat pane
 * render for a real conversation, from the listing's detail response.
 */
export function pendingChatFromListing(listing: any): any {
  return {
    id: pendingChatId(listing.id),
    pending: true,
    listing_id: String(listing.id),
    listing_title: listing.book_title || '',
    listing_photo: listing.photos?.[0] || listing.book_cover_url || '',
    listing_price: listing.price,
    listing_condition: listing.condition,
    listing_course: listing.course_name || '',
    other_party: listing.seller_name || '',
    other_party_role: 'seller',
    other_party_school_name: listing.school_name || '',
    other_party_avatar_url: listing.seller_avatar_url || '',
    seller_id: listing.seller,
    latest_message: '',
    updated_at: new Date().toISOString(),
    order_id: null,
    order_status: null,
  };
}

/** Where earlier versions kept pending chats; cleared on first use. */
const LEGACY_STORAGE_PREFIX = 'unibooks.chat.pending.';

@Injectable({ providedIn: 'root' })
export class PendingChatStore {
  private auth = inject(AuthStore);
  private region = inject(RegionService);
  private readonly chats = new Map<string, any[]>();

  constructor() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(LEGACY_STORAGE_PREFIX)) localStorage.removeItem(key);
      }
    } catch {
      // Storage unavailable: nothing was left in it either.
    }
  }

  private get key(): string | null {
    const userId = this.auth.user()?.id;
    return userId ? `${this.region.region()}.${userId}` : null;
  }

  /** This user's pending chats in this region, newest first. */
  list(): any[] {
    const key = this.key;
    return key ? [...(this.chats.get(key) ?? [])] : [];
  }

  save(chat: any): void {
    this.write([chat, ...this.list().filter(c => c.id !== chat.id)]);
  }

  remove(id: string): void {
    this.write(this.list().filter(c => c.id !== id));
  }

  private write(chats: any[]): void {
    const key = this.key;
    if (!key) return;
    if (chats.length) this.chats.set(key, chats);
    else this.chats.delete(key);
  }
}
