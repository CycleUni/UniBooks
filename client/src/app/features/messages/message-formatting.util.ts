// Pure formatting/parsing helpers extracted from the Messages component so
// they can be unit-tested standalone, without Angular DI or component state.

/**
 * Inbox-preview placeholder for an image message.
 *
 * Carries an i18n key instead of literal text because this preview is
 * persisted server-side (Django's `conversation.latest_message_body`) and
 * shown to *both* participants — who may be reading in different languages.
 * Resolving it at write time would bake one language into the database.
 * `formatSystemMessageForPreview` resolves it per viewer, using the same
 * `[SYSTEM:<i18nKey>]` convention the backend already uses for order
 * notifications.
 *
 * Must stay in sync with CFEdgeChat's IMAGE_PREVIEW_TOKEN (src/ChatRoom.ts),
 * which is what actually writes it for messages sent by the other party.
 */
export const IMAGE_PREVIEW_TOKEN = '[SYSTEM:msg.imagePlaceholder]';

/** Format a message timestamp relative to "now": time-only if today, weekday
 * if within the last week, month/day if this year, else full date. */
export function formatMessageTime(dateString: string, lang: 'en-US' | 'zh-TW'): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();

  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((nowStart.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));

  const isThisYear = date.getFullYear() === now.getFullYear();

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  if (diffDays === 0) {
    return timeStr;
  }

  if (diffDays < 7) {
    const weekday = new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(date);
    return `${weekday} ${timeStr}`;
  }

  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  if (isThisYear) {
    return `${month}/${day} ${timeStr}`;
  }

  const year = date.getFullYear();
  return `${year}/${month}/${day} ${timeStr}`;
}

/**
 * The short time shown on an inbox row. Narrower than formatMessageTime: the
 * row shares its line with the partner's name, role badge and unread dot, and
 * at phone width a "Wednesday 14:05" pushes the name down to a few letters.
 * Time of day for today, short weekday within the week, then month/day, and
 * the year only once it is no longer this year. Invalid or missing → ''.
 */
export function formatInboxTime(dateString: string | null | undefined, lang: 'en-US' | 'zh-TW', now: Date = new Date()): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((nowStart.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));

  // A timestamp slightly ahead of this device's clock (the server's clock, or
  // the chat worker's) still belongs to today, not to a negative day.
  if (diffDays <= 0) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  if (diffDays < 7) {
    return new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(date);
  }
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  if (date.getFullYear() === now.getFullYear()) {
    return monthDay;
  }
  return `${date.getFullYear()}/${monthDay}`;
}

// The control tokens a meetup card is drawn for. Matched at the start of the
// body only: that is where the server puts them, and the only position the
// chat refuses from a user (CFEdgeChat's isSystemMessage). Matched anywhere,
// "ok [SYSTEM:order.notify.seller_approved]" typed by the other party drew an
// official "seller approved" card.
const MEETUP_CARD_TOKENS = [
  '[MEETUP_REQUEST]',
  '[MEETUP_ACCEPT]',
  '[MEETUP_DECLINE]',
  '[MEETUP_CANCEL]',
  '[SYSTEM:order.notify.meetup_requested]',
  '[SYSTEM:order.notify.meetup_accepted]',
  '[SYSTEM:order.notify.meetup_declined]',
  '[SYSTEM:order.notify.meetup_cancelled]',
  '[SYSTEM:order.notify.seller_approved]',
  '[SYSTEM:order.notify.seller_rejected]',
  '[SYSTEM:order.notify.cancelled_by_buyer]',
  '[SYSTEM:order.notify.cancelled_by_seller]',
  '[SYSTEM:order.notify.delivered]',
  '[SYSTEM:order.notify.meetup_updated]',
] as const;

const MEETUP_DETAILS_TOKENS = [
  '[SYSTEM:order.notify.seller_approved]',
  '[SYSTEM:order.notify.meetup_accepted]',
  '[MEETUP_ACCEPT]',
  '[SYSTEM:order.notify.meetup_updated]',
] as const;

function startsWithAny(body: string, tokens: readonly string[]): boolean {
  return tokens.some(token => body.startsWith(token));
}

/** Whether a raw message body is one of the meetup-flow control messages
 * (request/accept/decline/cancel). Generic [SYSTEM:xxx] messages (e.g. order
 * cancellation notices) are NOT meetup cards and should render as normal messages. */
export function isMeetupRequest(body: string): boolean {
  if (!body) return false;
  return startsWithAny(body, MEETUP_CARD_TOKENS);
}

/** Whether a message is a card that carries the agreed meetup time/place:
 * the seller's accept, or a later edit of the details. */
export function isMeetupDetailsMessage(body: string): boolean {
  if (!body) return false;
  return startsWithAny(body, MEETUP_DETAILS_TOKENS);
}

/** The i18n key of a `[SYSTEM:<key>] …` message, or null for any other body. */
export function systemMessageKey(body: string): string | null {
  if (!body || !body.startsWith('[SYSTEM:')) return null;
  const match = body.match(/^\[SYSTEM:([^\]]+)\]/);
  return match ? match[1] : null;
}

/** Strip the control-message markers, leaving just the human-readable text. */
export function cleanMeetupBody(body: string): string {
  if (!body) return '';
  return body
    .replace(/\[SYSTEM:[^\]]+\]/g, '')
    .replace(/\[MEETUP_(REQUEST|ACCEPT|DECLINE|CANCEL)\]/g, '')
    .trim();
}
