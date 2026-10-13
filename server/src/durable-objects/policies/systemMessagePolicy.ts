// The control token only 'system' role tokens may send: order notices, some
// of which the app draws as official meetup cards.
const SYSTEM_MESSAGE_TOKEN = '[SYSTEM:';

/**
 * Whether `content` carries the control token anywhere in it.
 *
 * Anywhere, not just at the start: app versions before the fix drew a card
 * for a token found at any position, so "ok [SYSTEM:order.notify.
 * seller_approved]" from the other party showed an official "seller
 * approved" card. Those versions can stay cached in a service worker for a
 * while; refusing the message here protects them too.
 */
export function isSystemMessage(content: string): boolean {
  return content.includes(SYSTEM_MESSAGE_TOKEN);
}
