import { Injectable, signal } from '@angular/core';

export interface MeetupDetails {
  time: string;
  location: string;
}

export interface MeetupDetailsRequest {
  readonly id: number;
  readonly bookTitle: string;
  /** Set when editing details already agreed: the form starts from them. */
  readonly initial: MeetupDetails | null;
  readonly settle: (result: MeetupDetails | null) => void;
}

/**
 * Asks the seller for the meetup's time and place before a meetup order is
 * accepted, wherever the accept happens: the orders list and the meetup card
 * in a conversation both await this, so neither can accept without it.
 * Accepting from the chat card used to skip the form entirely.
 *
 * Promise-based like ConfirmService, for the same reason: the caller stays a
 * guard clause (`const details = await ask(...); if (!details) return;`). The
 * form itself is rendered once, by MeetupDetailsHost in the app shell.
 */
@Injectable({ providedIn: 'root' })
export class MeetupDetailsService {
  private nextId = 1;

  /** The request currently on screen, or null when none is. */
  readonly current = signal<MeetupDetailsRequest | null>(null);

  /** Resolves with what the seller entered, or null if they closed the form. */
  ask(bookTitle: string, initial: MeetupDetails | null = null): Promise<MeetupDetails | null> {
    // One form at a time: a second accept while one is open answers the
    // first as closed rather than stacking two forms.
    this.current()?.settle(null);
    return new Promise(resolve => {
      this.current.set({ id: this.nextId++, bookTitle, initial, settle: resolve });
    });
  }

  /** Answers the on-screen request. Called by the host only. */
  settle(id: number, result: MeetupDetails | null): void {
    const request = this.current();
    if (!request || request.id !== id) return;
    this.current.set(null);
    request.settle(result);
  }
}
