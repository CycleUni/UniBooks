import type { Env } from '../env';
import { siteOrigin } from '../lib/origin';
import type { AccountLinkKind, EmailMessage } from './types';
import { emailLanguageFor, t } from '../services/accounts/i18n';
import { regionDetails } from '../services/accounts/regionData';
import { displayName } from '../services/accounts/users';

/**
 * EMAIL_QUEUE consumer. Every email is written in one language (the request's
 * for account links, the recipient's email language for notifications), as plain text
 * plus an HTML part in which every interpolated value is escaped.
 *
 * Links point at the app's own routes on the site origin (lib/origin.ts): account pages
 * unprefixed (/account/...; the app adds the reader's region), region pages
 * prefixed (/<region>/messages?chat=..., /<region>/book?isbn=...).
 */

export interface RenderedEmail {
  to: string;
  name: string;
  subject: string;
  text: string;
  html: string;
}

/** Plain-text lines; a line that is exactly a URL becomes a link in the HTML part. */
type Line = string | { link: string } | { text: string; link: string };

const SYSTEM_PREVIEW_PREFIXES = ['[SYSTEM:', '[MEETUP_'];
const CHAT_EMAIL_PREVIEW_MAX_CHARS = 120;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line, no control characters: for display names and subjects. */
function oneLine(value: unknown): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** The site origin for links; resolved once per message by buildEmail(). */
let origin = 'https://unibooks.app';
function frontend(_env: Env): string {
  return origin;
}

function render(to: string, name: string, subject: string, lines: Line[]): RenderedEmail {
  const text = lines.map((l) => (typeof l === 'string' ? l : 'text' in l ? l.text : l.link)).join('\n');
  const htmlLines = lines.map((l) => {
    if (typeof l === 'string') return l ? `<p style="margin:0 0 4px">${escapeHtml(l)}</p>` : '<br>';
    const href = escapeHtml(l.link);
    const label = 'text' in l ? escapeHtml(l.text) : href;
    return `<p style="margin:0 0 4px"><a href="${href}" style="color:#2563eb;word-break:break-all">${label}</a></p>`;
  });
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1e293b">' +
    htmlLines.join('') +
    '</body></html>';
  return { to, name: oneLine(name), subject: oneLine(subject), text, html };
}

interface UserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  is_active: number;
  deleted_at: string | null;
  notify_new_message_email: number;
  email_language: string;
  site_language: string;
}

async function loadUser(env: Env, id: string | undefined | null): Promise<UserRow | null> {
  if (!id) return null;
  return env.DB.prepare(
    `SELECT id, email, first_name, last_name, is_active, deleted_at, notify_new_message_email, email_language, site_language
     FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<UserRow>();
}

function reachable(user: UserRow | null): user is UserRow {
  return !!user && !!user.is_active && !user.deleted_at && !!user.email;
}

async function languageFor(env: Env, user: UserRow, region: string | null | undefined): Promise<string> {
  const details = region ? await regionDetails(env, region) : null;
  return emailLanguageFor({ emailLanguage: user.email_language, siteLanguage: user.site_language }, details?.defaultLanguage);
}

/** The quotable part of a message, or null. */
export function chatEmailPreview(preview: string | null | undefined): string | null {
  let text = (preview ?? '').trim();
  if (!text || SYSTEM_PREVIEW_PREFIXES.some((p) => text.startsWith(p))) return null;
  text = text.split(/\s+/).join(' ');
  if (text.length > CHAT_EMAIL_PREVIEW_MAX_CHARS) text = text.slice(0, CHAT_EMAIL_PREVIEW_MAX_CHARS).trimEnd() + '…';
  return text;
}

function accountLink(env: Env, msg: Extract<EmailMessage, { type: 'account_link' }>): RenderedEmail | null {
  const kinds: AccountLinkKind[] = ['activation', 'eduVerification', 'passwordReset', 'emailChange'];
  if (!kinds.includes(msg.kind) || !msg.to || !msg.path.startsWith('/')) return null;
  const link = `${frontend(env)}${msg.path}`;
  return render(msg.to, msg.name, t(msg.lang, `email.${msg.kind}.subject`), [
    t(msg.lang, `email.${msg.kind}.intro`),
    '',
    { link },
    '',
    t(msg.lang, `email.${msg.kind}.ignore`),
  ]);
}

async function chatNotification(
  env: Env,
  msg: Extract<EmailMessage, { type: 'offline_chat_notification' }>,
): Promise<RenderedEmail | null> {
  const conv = await env.DB.prepare(
    `SELECT id, region_code, buyer_id, seller_id, book_title, buyer_deleted_at, seller_deleted_at
     FROM conversations WHERE ${msg.conversation_id ? 'id' : 'room_id'} = ?`,
  )
    .bind(msg.conversation_id ?? msg.room_id)
    .first<{
      id: string;
      region_code: string;
      buyer_id: string;
      seller_id: string;
      book_title: string;
      buyer_deleted_at: string | null;
      seller_deleted_at: string | null;
    }>();
  if (!conv) return null;

  let otherId: string;
  let hiddenAt: string | null;
  if (conv.buyer_id === msg.recipient_id) {
    otherId = conv.seller_id;
    hiddenAt = conv.buyer_deleted_at;
  } else if (conv.seller_id === msg.recipient_id) {
    otherId = conv.buyer_id;
    hiddenAt = conv.seller_deleted_at;
  } else {
    console.warn(`[email] offline email for room ${msg.room_id} names a non-participant recipient`);
    return null;
  }
  // They deleted this conversation: the link would lead nowhere they can see.
  if (hiddenAt) return null;

  const [recipient, sender] = await Promise.all([loadUser(env, msg.recipient_id), loadUser(env, otherId)]);
  if (!reachable(recipient)) return null;
  // Notifications page switch.
  if (!recipient.notify_new_message_email) return null;

  const senderName = oneLine(sender ? displayName(sender.first_name, sender.last_name) : '') || 'UniBooks';
  const listingTitle = conv.book_title || msg.listing_title || '';
  const region = String(conv.region_code).toLowerCase();
  const link = `${frontend(env)}/${encodeURIComponent(region)}/messages?chat=${encodeURIComponent(conv.id)}`;
  const settingsLink = `${frontend(env)}/account/notifications`;
  const quoted = chatEmailPreview(msg.preview);
  const lang = await languageFor(env, recipient, conv.region_code);

  const lines: Line[] = [t(lang, 'email.chatMessage.intro', { sender: senderName }), ''];
  if (listingTitle) lines.push(t(lang, 'email.chatMessage.listing', { title: listingTitle }));
  if (quoted) lines.push(t(lang, 'email.chatMessage.message', { preview: quoted }));
  lines.push('', { text: t(lang, 'email.chatMessage.open', { link }), link }, '', t(lang, 'email.chatMessage.once'), '', {
    text: t(lang, 'email.chatMessage.turnOff', { link: settingsLink }),
    link: settingsLink,
  });
  return render(
    recipient.email,
    displayName(recipient.first_name, recipient.last_name),
    t(lang, 'email.chatMessage.subject', { sender: senderName }),
    lines,
  );
}

async function waitlist(env: Env, msg: Extract<EmailMessage, { type: 'waitlist_notification' }>): Promise<RenderedEmail | null> {
  const user = await loadUser(env, msg.user_id);
  if (!reachable(user)) return null;
  const books = msg.books?.length ? msg.books : [{ title: msg.book_title, isbn13: null, region: msg.region }];
  const lang = await languageFor(env, user, books[0]?.region || msg.region);
  const base = frontend(env);
  const lines: Line[] = [t(lang, 'email.waitlist.intro'), ''];
  for (const book of books) {
    const region = encodeURIComponent(String(book.region || msg.region || env.DEFAULT_REGION || 'tw').toLowerCase());
    const url = book.isbn13 ? `${base}/${region}/book?isbn=${encodeURIComponent(book.isbn13)}` : `${base}/${region}`;
    lines.push({ text: `- ${book.title}: ${url}`, link: url });
  }
  const requestPage = `${base}/account/subscriptions`;
  lines.push('', t(lang, 'email.waitlist.logIn'), '', t(lang, 'email.waitlist.stop'), { link: requestPage });
  return render(user.email, displayName(user.first_name, user.last_name), t(lang, 'email.waitlist.subject'), lines);
}

/** "YYYY-MM-DD HH:mm" in `timeZone` . */
export function formatMeetupTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

async function meetupReminder(env: Env, msg: Extract<EmailMessage, { type: 'meetup_reminder' }>): Promise<RenderedEmail | null> {
  const user = await loadUser(env, msg.user_id);
  if (!reachable(user)) return null;
  const details = msg.region ? await regionDetails(env, msg.region) : null;
  const lang = await languageFor(env, user, msg.region);
  const time = formatMeetupTime(msg.meetup_time, msg.timezone || details?.timezone || 'UTC');
  const ordersPage = `${frontend(env)}/account/orders`;
  const lines: Line[] = [
    t(lang, 'email.meetupReminder.intro'),
    '',
    t(lang, 'email.meetupReminder.book', { title: msg.book_title }),
    t(lang, 'email.meetupReminder.time', { time }),
  ];
  if (msg.meetup_location) lines.push(t(lang, 'email.meetupReminder.location', { location: msg.meetup_location }));
  lines.push('', { text: t(lang, 'email.meetupReminder.viewOrder', { link: ordersPage }), link: ordersPage });
  return render(
    user.email,
    displayName(user.first_name, user.last_name),
    t(lang, 'email.meetupReminder.subject', { title: msg.book_title }),
    lines,
  );
}

/** Build the email for a queue message, or null when nothing should be sent. */
export async function buildEmail(msg: EmailMessage, env: Env): Promise<RenderedEmail | null> {
  origin = await siteOrigin(env);
  switch (msg.type) {
    case 'account_link':
      return accountLink(env, msg);
    case 'offline_chat_notification':
      return chatNotification(env, msg);
    case 'waitlist_notification':
      return waitlist(env, msg);
    case 'meetup_reminder':
      return meetupReminder(env, msg);
    default:
      console.warn('[email] unknown message type', (msg as { type?: unknown }).type);
      return null;
  }
}

async function sendViaMailjet(env: Env, email: RenderedEmail): Promise<void> {
  const payload = {
    Messages: [
      {
        From: { Email: env.DEFAULT_FROM_EMAIL || 'no-reply@unibooks.app', Name: 'UniBooks' },
        To: [email.name ? { Email: email.to, Name: email.name } : { Email: email.to }],
        Subject: email.subject,
        TextPart: email.text,
        HTMLPart: email.html,
      },
    ],
    // Mailjet validates the message but delivers nothing (for test runs).
    ...(env.MAILJET_SANDBOX === '1' ? { SandboxMode: true } : {}),
  };
  const response = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    // Status only: the body may echo the address (PII).
    throw new Error(`Mailjet API error (${response.status})`);
  }
  if (env.MAILJET_SANDBOX === '1') console.log(`[email] Mailjet sandbox accepted "${email.subject}"`);
}

export async function processEmailMessage(msg: EmailMessage, env: Env): Promise<void> {
  const email = await buildEmail(msg, env);
  if (!email) return;
  if (!env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY) {
    // Never log the body: account links carry bearer tokens.
    console.warn(`[email] Mailjet not configured; ${msg.type} email not sent`);
    return;
  }
  await sendViaMailjet(env, email);
}

export async function handleEmailQueue(batch: MessageBatch<EmailMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processEmailMessage(message.body, env);
      message.ack();
    } catch (error) {
      // Neither the payload (tokens, message text) nor the address is logged.
      console.error(`[email] failed to send ${message.body?.type ?? 'unknown'} email`, error);
      message.retry();
    }
  }
}
