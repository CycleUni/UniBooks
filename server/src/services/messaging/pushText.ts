/**
 * Push notification wording, in the recipient's language.
 */

export type PushLang = 'en' | 'zh-TW' | 'zh-HK';
export const PUSH_LANGUAGES: readonly PushLang[] = ['en', 'zh-TW', 'zh-HK'];

const CATALOG: Record<PushLang, Record<string, string>> = {
  en: {
    'push.chatMessage.title': '{sender} sent you a message',
    'push.chatMessage.listing': 'About: {title}',
    'push.chatMessage.generic': 'Open UniBooks to read it.',
    'push.orderNotify.title': 'Order update: {title}',
    'push.orderNotify.meetup_requested': 'A buyer placed a meetup order and is waiting for your confirmation.',
    'push.orderNotify.meetup_updated': 'The seller updated the meetup time and place.',
    'push.orderNotify.seller_approved': 'The seller accepted your meetup.',
    'push.orderNotify.seller_rejected': 'The seller rejected the meetup, so the order was cancelled.',
    'push.orderNotify.delivered': 'The meetup is complete. Thank you for using UniBooks!',
    'push.orderNotify.cancelled_by_buyer': 'The buyer cancelled the order.',
    'push.orderNotify.cancelled_by_seller': 'The seller cancelled the order.',
    'push.orderNotify.admin_cancelled': 'This order was cancelled by UniBooks.',
    'push.orderNotify.cancelled': 'The order was cancelled.',
    'push.orderNotify.updated': 'Open UniBooks to see the details.',
    'push.meetupReminder.title': 'Your meetup is coming up',
    'push.meetupReminder.body': '{title} — {time}',
    'push.waitlist.title': 'New listings for your book requests',
    'push.waitlist.one': '{title} is now listed.',
    'push.waitlist.many': '{title} and {count} more of your requested books are now listed.',
  },
  'zh-TW': {
    'push.chatMessage.title': '{sender} 傳送了新訊息給您',
    'push.chatMessage.listing': '書籍：{title}',
    'push.chatMessage.generic': '開啟 UniBooks 查看。',
    'push.orderNotify.title': '訂單更新：{title}',
    'push.orderNotify.meetup_requested': '買家下了面交訂單，等待您確認。',
    'push.orderNotify.meetup_updated': '賣家更新了面交時間與地點。',
    'push.orderNotify.seller_approved': '賣家已接受您的面交。',
    'push.orderNotify.seller_rejected': '賣家拒絕了面交，訂單已取消。',
    'push.orderNotify.delivered': '面交已完成，感謝您使用 UniBooks！',
    'push.orderNotify.cancelled_by_buyer': '買家取消了訂單。',
    'push.orderNotify.cancelled_by_seller': '賣家取消了訂單。',
    'push.orderNotify.admin_cancelled': '這筆訂單已被 UniBooks 取消。',
    'push.orderNotify.cancelled': '訂單已取消。',
    'push.orderNotify.updated': '開啟 UniBooks 查看詳情。',
    'push.meetupReminder.title': '面交時間快到了',
    'push.meetupReminder.body': '{title}：{time}',
    'push.waitlist.title': '您登記的書有新上架',
    'push.waitlist.one': '《{title}》已有人上架。',
    'push.waitlist.many': '《{title}》等 {count} 本您登記的書已有人上架。',
  },
  'zh-HK': {
    'push.chatMessage.title': '{sender} 向你傳送了新訊息',
    'push.chatMessage.listing': '書籍：{title}',
    'push.chatMessage.generic': '開啟 UniBooks 查看。',
    'push.orderNotify.title': '訂單更新：{title}',
    'push.orderNotify.meetup_requested': '買家落咗面交訂單，等緊你確認。',
    'push.orderNotify.meetup_updated': '賣家更新咗面交時間同地點。',
    'push.orderNotify.seller_approved': '賣家已接受你嘅面交。',
    'push.orderNotify.seller_rejected': '賣家拒絕咗面交，訂單已取消。',
    'push.orderNotify.delivered': '面交已完成，多謝使用 UniBooks！',
    'push.orderNotify.cancelled_by_buyer': '買家取消咗訂單。',
    'push.orderNotify.cancelled_by_seller': '賣家取消咗訂單。',
    'push.orderNotify.admin_cancelled': '呢張訂單已被 UniBooks 取消。',
    'push.orderNotify.cancelled': '訂單已取消。',
    'push.orderNotify.updated': '開啟 UniBooks 睇詳情。',
    'push.meetupReminder.title': '面交時間就快到',
    'push.meetupReminder.body': '{title}：{time}',
    'push.waitlist.title': '你登記嘅書有新上架',
    'push.waitlist.one': '《{title}》已經有人上架。',
    'push.waitlist.many': '《{title}》等 {count} 本你登記嘅書已經有人上架。',
  },
};

export function pushT(lang: PushLang, key: string, params: Record<string, string | number> = {}): string {
  const template = CATALOG[lang][key] ?? CATALOG.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/**
 * The user's chosen email language, else the
 * language they last used the site in, else the region's default, else en.
 */
export function languageFor(user: { emailLanguage: string; siteLanguage: string }, regionDefaultLanguage?: string | null): PushLang {
  for (const candidate of [user.emailLanguage === 'auto' ? null : user.emailLanguage, user.siteLanguage, regionDefaultLanguage]) {
    if (candidate && (PUSH_LANGUAGES as readonly string[]).includes(candidate)) return candidate as PushLang;
  }
  return 'en';
}

/**
 * The order events the push has wording for. Every order notice the orders
 * module posts into a chat (`[SYSTEM:order.notify.<event>] ...`) must be here.
 */
export const ORDER_PUSH_EVENTS = [
  'meetup_requested',
  'meetup_updated',
  'seller_approved',
  'seller_rejected',
  'delivered',
  'cancelled_by_buyer',
  'cancelled_by_seller',
  'admin_cancelled',
] as const;

const ORDER_EVENT_PREVIEW = /^\[SYSTEM:order\.notify\.([a-z_]+)\]/;

/** The order event a system-message preview announces, or null. */
export function orderEventIn(preview: string | undefined | null): string | null {
  const m = ORDER_EVENT_PREVIEW.exec(preview ?? '');
  return m && (ORDER_PUSH_EVENTS as readonly string[]).includes(m[1]) ? m[1] : null;
}

/** Collapse whitespace (a display name goes into a one-line title). */
export const oneLine = (s: string | null | undefined) => (s ?? '').split(/\s+/).filter(Boolean).join(' ');
