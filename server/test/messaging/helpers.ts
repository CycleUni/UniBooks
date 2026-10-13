import { env, exports } from 'cloudflare:workers';
import { createDb, currencies, languages, regions, users, books, listings, regionVerifications, conversations } from '../../src/db';
import { signToken } from '../../src/lib/jwt';

/**
 * Whether the migrated test D1 has the messaging/moderation columns this
 * module writes. The lead regenerates src/db/migrations from schema.ts; until
 * then the integration specs skip themselves instead of failing on old DDL.
 */
export async function hasMessagingSchema(): Promise<boolean> {
  const cols = async (t: string) =>
    (await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(t).all<{ name: string }>()).results.map((r) => r.name);
  const [conv, rep, chat] = await Promise.all([cols('conversations'), cols('reports'), cols('chat_reports')]);
  return (
    conv.includes('buyer_deleted_at') &&
    conv.includes('latest_message_body') &&
    rep.includes('listing_ref') &&
    chat.includes('flagged_message_ids') &&
    chat.includes('reported_party_id')
  );
}

const now = () => new Date().toISOString();

export async function seedRegion(code = 'TW') {
  const db = createDb(env.DB);
  await db.insert(currencies).values({ code: 'TWD', symbol: 'NT$' }).onConflictDoNothing();
  await db.insert(languages).values({ code: 'zh-TW', name: 'Chinese (Taiwan)' }).onConflictDoNothing();
  await db
    .insert(regions)
    .values({ code, name: code, defaultCurrency: 'TWD', defaultLanguage: 'zh-TW', timezone: 'Asia/Taipei', createdAt: now() })
    .onConflictDoNothing();
}

export async function seedUser(opts: { role?: 'user' | 'staff' | 'admin'; verifiedIn?: string; banned?: boolean } = {}) {
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: `${id.slice(0, 8)}@example.com`,
    name: `User ${id.slice(0, 4)}`,
    role: opts.role ?? 'user',
    isBanned: opts.banned ? 1 : 0,
    createdAt: now(),
    updatedAt: now(),
  });
  if (opts.verifiedIn) {
    await db.insert(regionVerifications).values({ userId: id, regionCode: opts.verifiedIn, verifiedAt: now(), isActive: 1 });
  }
  const token = await signToken('access', { user_id: id }, env.JWT_SIGNING_KEY);
  return { id, token };
}

export async function seedListing(sellerId: string, region = 'TW', status: 'active' | 'sold' | 'removed' = 'active') {
  const db = createDb(env.DB);
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, regionCode: region, title: 'Calculus', source: 'manual', createdAt: now() });
  const id = crypto.randomUUID();
  await db.insert(listings).values({
    id,
    regionCode: region,
    currencyCode: 'TWD',
    bookId,
    sellerId,
    price: 100,
    condition: 'new',
    status,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

export async function seedConversation(buyerId: string, sellerId: string, listingId: string | null, region = 'TW') {
  const id = crypto.randomUUID();
  await createDb(env.DB)
    .insert(conversations)
    .values({
      id,
      roomId: id,
      regionCode: region,
      buyerId,
      sellerId,
      listingId,
      listingRef: listingId ?? crypto.randomUUID(),
      bookTitle: 'Calculus',
      updatedAt: now(),
      createdAt: now(),
    });
  return id;
}

export function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('X-Region')) headers.set('X-Region', 'TW');
  const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
  return worker.fetch(new Request(`http://x${path}`, { ...init, headers }));
}
