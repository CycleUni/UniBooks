import { and, eq } from 'drizzle-orm';
import type { Env } from '../env';
import { createDb, orders, pushDevices, regions } from '../db';
import { siteOrigin } from '../lib/origin';
import { formatMeetupTime } from '../lib/time';
import type { PushMessage } from './types';
import { getConversation } from '../services/messaging/conversations';
import { loadPerson, type Person } from '../services/messaging/people';
import { languageFor, oneLine, orderEventIn, pushT, ORDER_PUSH_EVENTS, type PushLang } from '../services/messaging/pushText';

/**
 * PUSH_QUEUE consumer: browser push over FCM HTTP v1.
 *
 * Data-only messages {title, body, link}: the app's service worker (public/sw.js)
 * builds the notification itself, so the wording is exactly what is written
 * here, in the recipient's language. Honours the user's push switch and
 * account state for every message type, and drops devices FCM reports gone.
 */

const FCM_TOKEN_KV_KEY = 'fcm_access_token';
const MESSAGE_TTL_SECONDS = 24 * 60 * 60;

interface FirebaseServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

export async function handlePushQueue(batch: MessageBatch<PushMessage>, env: Env): Promise<void> {
  const account = serviceAccount(env);
  for (const message of batch.messages) {
    try {
      if (account) await processPushMessage(message.body, env, account);
      message.ack();
    } catch (error) {
      // The payload is not logged: it may quote private conversation context.
      console.error('[PushWorker] push failed for', message.body?.type, error);
      message.retry();
    }
  }
}

/** The parsed service-account key (raw JSON or base64 of it), or null when push is not configured. */
function serviceAccount(env: Env): FirebaseServiceAccount | null {
  let raw = (env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (!raw) return null;
  try {
    if (!raw.startsWith('{')) raw = atob(raw);
    const parsed = JSON.parse(raw) as FirebaseServiceAccount;
    if (!parsed.client_email || !parsed.private_key) throw new Error('client_email / private_key missing');
    return parsed;
  } catch {
    console.error('[PushWorker] FIREBASE_SERVICE_ACCOUNT_JSON is set but is not a usable service-account key');
    return null;
  }
}

function base64UrlEncode(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBinary(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN[ A-Z0-9_-]+-----/g, '')
    .replace(/-----END[ A-Z0-9_-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** FCM and Google OAuth normally answer within a second or two. */
const FCM_TIMEOUT_MS = 10_000;

/** OAuth2 access token for FCM, cached in KV for 55 minutes. */
export async function getFCMAccessToken(env: Env, account = serviceAccount(env)): Promise<string | null> {
  if (!account) return null;
  if (env.KV) {
    const cached = await env.KV.get(FCM_TOKEN_KV_KEY).catch(() => null);
    if (cached) return cached;
  }
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64UrlEncode(
    JSON.stringify({
      iss: account.client_email,
      aud: tokenUri,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBinary(account.private_key!),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const res = await fetch(tokenUri, {
    method: 'POST',
    signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed (${res.status})`);
  const { access_token } = (await res.json()) as { access_token: string };
  if (env.KV && access_token) {
    await env.KV.put(FCM_TOKEN_KV_KEY, access_token, { expirationTtl: 55 * 60 }).catch(() => {});
  }
  return access_token;
}

export interface RenderedPush {
  recipientId: string;
  title: string;
  body: string;
  link: string;
}

async function regionInfo(env: Env, code: string | null | undefined) {
  if (!code) return null;
  const [row] = await createDb(env.DB)
    .select({ code: regions.code, default_language: regions.defaultLanguage, timezone: regions.timezone })
    .from(regions)
    .where(eq(regions.code, code))
    .limit(1);
  return row ?? null;
}

async function orderRegion(env: Env, orderId: string): Promise<string | null> {
  const [row] = await createDb(env.DB).select({ regionCode: orders.regionCode }).from(orders).where(eq(orders.id, orderId)).limit(1);
  return row?.regionCode ?? null;
}

const ORDER_STATUS_EVENT: Record<string, string> = {
  pending: 'meetup_requested',
  accepted: 'seller_approved',
  completed: 'delivered',
  cancelled: 'cancelled',
};

/**
 * Title, body and link for one queued message, or null when nothing should
 * be sent (no such recipient, push switched off, account gone, conversation
 * hidden by the recipient).
 */
export async function renderPush(msg: PushMessage, env: Env): Promise<RenderedPush | null> {
  const frontend = await siteOrigin(env);
  const reachable = (p: Person | null): p is Person => !!p && p.isActive && !p.deleted && !p.isBanned && p.notifyPush;

  switch (msg.type) {
    case 'chat_message': {
      const conv = await getConversation(env, msg.conversation_id || msg.room_id);
      if (!conv) return null;
      let recipientId = msg.recipient_id ?? null;
      if (!recipientId && msg.sender_id) {
        recipientId = msg.sender_id === conv.buyer_id ? conv.seller_id : msg.sender_id === conv.seller_id ? conv.buyer_id : null;
      }
      if (!recipientId) return null;
      const hiddenAt =
        recipientId === conv.buyer_id ? conv.buyer_deleted_at : recipientId === conv.seller_id ? conv.seller_deleted_at : 'x';
      if (hiddenAt) return null;
      const [recipient, sender, region] = await Promise.all([
        loadPerson(env, recipientId),
        msg.sender_id ? loadPerson(env, msg.sender_id) : Promise.resolve(null),
        regionInfo(env, conv.region_code),
      ]);
      if (!reachable(recipient)) return null;
      const lang = languageFor(recipient, region?.default_language);
      const senderName = oneLine(msg.sender_name || sender?.displayName) || 'UniBooks';
      // Never quote the message: a push can be read on a locked screen.
      const event = orderEventIn(msg.preview);
      let title: string;
      let body: string;
      if (event) {
        title = pushT(lang, 'push.orderNotify.title', { title: conv.book_title || 'UniBooks' });
        body = pushT(lang, `push.orderNotify.${event}`);
      } else {
        title = pushT(lang, 'push.chatMessage.title', { sender: senderName });
        body = conv.book_title
          ? pushT(lang, 'push.chatMessage.listing', { title: conv.book_title })
          : pushT(lang, 'push.chatMessage.generic');
      }
      return {
        recipientId,
        title,
        body,
        link: `${frontend}/${conv.region_code.toLowerCase()}/messages?chat=${encodeURIComponent(conv.id)}`,
      };
    }

    case 'order_update': {
      const recipient = await loadPerson(env, msg.user_id);
      if (!reachable(recipient)) return null;
      const region = await regionInfo(env, await orderRegion(env, msg.order_id));
      const lang: PushLang = languageFor(recipient, region?.default_language);
      const event =
        msg.event && (ORDER_PUSH_EVENTS as readonly string[]).includes(msg.event)
          ? msg.event
          : (ORDER_STATUS_EVENT[msg.status] ?? 'updated');
      return {
        recipientId: msg.user_id,
        title: pushT(lang, 'push.orderNotify.title', { title: msg.book_title || 'UniBooks' }),
        body: pushT(lang, `push.orderNotify.${event}`),
        link: `${frontend}/account/orders`,
      };
    }

    case 'waitlist_match': {
      const recipient = await loadPerson(env, msg.user_id);
      if (!reachable(recipient)) return null;
      const lang = languageFor(recipient);
      const others = Math.max(0, (msg.listing_count ?? 1) - 1);
      return {
        recipientId: msg.user_id,
        title: pushT(lang, 'push.waitlist.title'),
        body:
          others > 0
            ? pushT(lang, 'push.waitlist.many', { title: msg.book_title, count: others })
            : pushT(lang, 'push.waitlist.one', { title: msg.book_title }),
        link: `${frontend}/account/subscriptions`,
      };
    }

    case 'meetup_reminder': {
      const recipient = await loadPerson(env, msg.user_id);
      if (!reachable(recipient)) return null;
      const region = await regionInfo(env, await orderRegion(env, msg.order_id));
      const lang = languageFor(recipient, region?.default_language);
      return {
        recipientId: msg.user_id,
        title: pushT(lang, 'push.meetupReminder.title'),
        body: pushT(lang, 'push.meetupReminder.body', {
          title: msg.book_title,
          time: formatMeetupTime(msg.meetup_time, region?.timezone || 'UTC'),
        }),
        link: `${frontend}/account/orders`,
      };
    }
  }
  return null;
}

/** Render and send one message to every device the recipient registered. */
export async function processPushMessage(msg: PushMessage, env: Env, account: FirebaseServiceAccount): Promise<number> {
  const push = await renderPush(msg, env);
  if (!push) return 0;
  const devices = await createDb(env.DB)
    .select({ id: pushDevices.id, token: pushDevices.token })
    .from(pushDevices)
    .where(and(eq(pushDevices.userId, push.recipientId), eq(pushDevices.isActive, 1)));
  if (!devices.length) return 0;

  const projectId = env.FIREBASE_PROJECT_ID || account.project_id;
  if (!projectId) {
    console.error('[PushWorker] Firebase project id could not be determined');
    return 0;
  }
  const accessToken = await getFCMAccessToken(env, account);
  if (!accessToken) return 0;

  return deliver(env, `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, accessToken, devices, push);
}

/**
 * Send one rendered push to each device. Devices FCM reports unregistered
 * are removed. Throws (so the queue retries) only when nothing was
 * delivered for a reason worth retrying: a retry resends to every device.
 */
export async function deliver(
  env: Env,
  url: string,
  accessToken: string,
  devices: { id: number; token: string }[],
  push: Pick<RenderedPush, 'title' | 'body' | 'link'>,
): Promise<number> {
  let sent = 0;
  let transient = 0;
  let unauthorized = false;
  const gone: number[] = [];
  await Promise.all(
    devices.map(async (device) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: device.token,
              data: { title: push.title, body: push.body, link: push.link },
              webpush: { headers: { TTL: String(MESSAGE_TTL_SECONDS) } },
            },
          }),
        });
        if (res.ok) {
          sent++;
          return;
        }
        const text = await res.text().catch(() => '');
        if (res.status === 404 && text.includes('UNREGISTERED')) gone.push(device.id);
        else {
          if (res.status === 401) unauthorized = true;
          if (res.status === 429 || res.status >= 500) transient++;
          console.warn(`[PushWorker] FCM rejected a send with HTTP ${res.status}`);
        }
      } catch (e) {
        transient++;
        console.error('[PushWorker] FCM send failed', e);
      }
    }),
  );
  if (gone.length) {
    await env.DB.prepare(`DELETE FROM push_devices WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(gone)).run();
  }
  // A rejected access token stays cached for up to 55 minutes; drop it so
  // the retry mints a fresh one.
  if (unauthorized && env.KV) await env.KV.delete(FCM_TOKEN_KV_KEY).catch(() => {});
  // Retried only when nothing was delivered: a retry resends to every
  // device, and a push already shown should not appear twice.
  if (sent === 0 && (transient > 0 || unauthorized)) {
    throw new Error(`FCM delivery failed for every device (${transient} transient, unauthorized: ${unauthorized})`);
  }
  return sent;
}
