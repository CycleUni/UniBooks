/**
 * Queue message payload definitions for UniBooks.
 *
 * EMAIL_QUEUE messages are rendered by queues/emailWorker.ts in the
 * recipient's language, with every
 * interpolated value HTML-escaped and links built against the site origin (lib/origin.ts).
 */

/** The four single-use-link account emails. */
export type AccountLinkKind = 'activation' | 'eduVerification' | 'passwordReset' | 'emailChange';

export type EmailMessage =
  | {
      type: 'account_link';
      kind: AccountLinkKind;
      user_id: string;
      /** Address the link goes to (the new address for an email change, the campus address for edu). */
      to: string;
      /** Display name for the To: header ('' for none). */
      name: string;
      /** Language the request was made in. */
      lang: string;
      /** Frontend path + query, e.g. "/verify?token=...&type=register"; the site origin is prepended. */
      path: string;
    }
  | {
      type: 'offline_chat_notification';
      recipient_id: string;
      room_id: string;
      sender_id: string;
      preview: string;
      /** Optional; looked up from the conversation by room_id when absent. */
      conversation_id?: string;
      listing_title?: string;
      region?: string;
    }
  | {
      type: 'waitlist_notification';
      user_id: string;
      email: string;
      book_title: string;
      listing_count: number;
      region: string;
      /** Every due book for this user, for one email per user (the cron); book_title alone otherwise. */
      books?: { title: string; isbn13?: string | null; region?: string }[];
    }
  | {
      type: 'meetup_reminder';
      user_id: string;
      email: string;
      order_id: string;
      book_title: string;
      /** ISO timestamp; shown in the region's timezone. */
      meetup_time: string;
      meetup_location: string;
      region?: string;
      timezone?: string;
    };

export type PushMessage =
  | {
      type: 'chat_message';
      recipient_id?: string;
      sender_name?: string;
      sender_id?: string;
      preview?: string;
      content?: string;
      room_id: string;
      conversation_id?: string;
      timestamp?: number;
      is_offline?: boolean;
    }
  | {
      type: 'order_update';
      user_id: string;
      order_id: string;
      status: string;
      book_title: string;
      /** Optional order.notify.<event> key for exact wording (see services/messaging/pushText ORDER_PUSH_EVENTS). */
      event?: string;
    }
  | { type: 'waitlist_match'; user_id: string; book_title: string; listing_count: number }
  | { type: 'meetup_reminder'; user_id: string; order_id: string; book_title: string; meetup_time: string };
