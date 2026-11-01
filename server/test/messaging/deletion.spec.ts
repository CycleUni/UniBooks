import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { api, hasMessagingSchema, seedConversation, seedListing, seedRegion, seedUser } from './helpers';
import { mintChatToken } from '../../src/services/chatTokens';
import { chatRoomStub } from '../../src/lib/chat';
import { deleteAccount } from '../../src/services/accounts/users';
import { sweepDeletedConversations } from '../../src/services/messaging/conversations';
import { chatReports, createDb, users } from '../../src/db';
import { eq } from 'drizzle-orm';

const ready = await hasMessagingSchema();

// Messages live in each conversation's ChatRoom, images in R2 under the
// sender's chat/ folder; a conversation nobody needs must take both with it.
describe.skipIf(!ready)('removing a conversation nobody needs', () => {
  beforeAll(() => seedRegion());

  async function chat() {
    const seller = await seedUser();
    const buyer = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    return { seller, buyer, conv };
  }

  /** Sends a text and an image (a real file in the buyer's chat folder) into the room. */
  async function talk(conv: string, buyerId: string, sellerId: string) {
    const key = `chat/${buyerId}/${crypto.randomUUID()}.webp`;
    await env.R2.put(key, new Uint8Array([1, 2, 3]));
    const tok = await mintChatToken(env, { userId: buyerId, roomId: conv, participantIds: [buyerId, sellerId], role: 'user' });
    const post = (body: unknown) =>
      api(`/api/chat/rooms/${conv}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
    expect((await post({ content: 'still available?' })).status).toBe(200);
    const base = String(env.R2_PUBLIC_URL).replace(/\/+$/, '');
    expect((await post({ content: `${base}/${key}`, message_type: 'image' })).status).toBe(200);
    return key;
  }

  const messagesInRoom = (conv: string) =>
    runInDurableObject(chatRoomStub(env, conv), async (_room, state) => {
      const tables = [...state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`)];
      if (!tables.length) return 0;
      return Number([...state.storage.sql.exec(`SELECT COUNT(*) AS n FROM messages`)][0].n);
    });
  const rowExists = async (conv: string) => !!(await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?').bind(conv).first());
  const del = (conv: string, token: string) => api(`/api/v1/messaging/conversations/${conv}`, { method: 'DELETE', token });

  it('keeps everything while only one side has deleted it', async () => {
    const { seller, buyer, conv } = await chat();
    const key = await talk(conv, buyer.id, seller.id);

    expect(await (await del(conv, buyer.token)).json()).toEqual({ status: 'hidden' });

    expect(await rowExists(conv)).toBe(true);
    expect(await messagesInRoom(conv)).toBe(2);
    expect(await env.R2.head(key)).not.toBeNull();
  });

  it('takes the messages and images with it once both sides delete it', async () => {
    const { seller, buyer, conv } = await chat();
    const key = await talk(conv, buyer.id, seller.id);

    await del(conv, buyer.token);
    expect(await (await del(conv, seller.token)).json()).toEqual({ status: 'deleted' });

    expect(await rowExists(conv)).toBe(false);
    expect(await messagesInRoom(conv)).toBe(0);
    expect(await env.R2.head(key)).toBeNull();
  });

  it('removes it when one side deleted their account and the other deletes the conversation', async () => {
    const { seller, buyer, conv } = await chat();
    const key = await talk(conv, buyer.id, seller.id);

    await deleteAccount(env, buyer.id);
    // The seller still has the history until they delete it.
    expect(await rowExists(conv)).toBe(true);
    expect(await messagesInRoom(conv)).toBe(2);

    expect(await (await del(conv, seller.token)).json()).toEqual({ status: 'deleted' });
    expect(await messagesInRoom(conv)).toBe(0);
    expect(await env.R2.head(key)).toBeNull();
  });

  it('removes it at once when the other side had already deleted it before the account went', async () => {
    const { seller, buyer, conv } = await chat();
    await talk(conv, buyer.id, seller.id);
    await del(conv, seller.token);

    await deleteAccount(env, buyer.id);

    expect(await rowExists(conv)).toBe(false);
    expect(await messagesInRoom(conv)).toBe(0);
  });

  it('removes it when both sides deleted their accounts', async () => {
    const { seller, buyer, conv } = await chat();
    const key = await talk(conv, buyer.id, seller.id);

    await deleteAccount(env, seller.id);
    expect(await rowExists(conv)).toBe(true);
    await deleteAccount(env, buyer.id);

    expect(await rowExists(conv)).toBe(false);
    expect(await messagesInRoom(conv)).toBe(0);
    expect(await env.R2.head(key)).toBeNull();
    // With nothing left pointing at it, the second account went outright.
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(buyer.id).first()).toBeNull();
  });

  it('waits for an open report, which names messages in the room, to be resolved', async () => {
    const { seller, buyer, conv } = await chat();
    await talk(conv, buyer.id, seller.id);
    const db = createDb(env.DB);
    const reportId = crypto.randomUUID();
    await db.insert(chatReports).values({
      id: reportId,
      reporterId: seller.id,
      conversationId: conv,
      regionCode: 'TW',
      reportedPartyId: buyer.id,
      reason: 'scam',
      createdAt: new Date().toISOString(),
    });

    await del(conv, buyer.token);
    expect(await (await del(conv, seller.token)).json()).toEqual({ status: 'hidden' });
    expect(await messagesInRoom(conv)).toBe(2);

    await db.update(chatReports).set({ status: 'dismissed' }).where(eq(chatReports.id, reportId));
    expect(await sweepDeletedConversations(env)).toBeGreaterThanOrEqual(1);

    expect(await rowExists(conv)).toBe(false);
    expect(await messagesInRoom(conv)).toBe(0);
  });

  it('catches up on accounts deleted before their side was marked', async () => {
    const { seller, buyer, conv } = await chat();
    await talk(conv, buyer.id, seller.id);
    await del(conv, seller.token);
    // As an account deletion left it before: anonymized, its side unmarked.
    await createDb(env.DB).update(users).set({ deletedAt: new Date().toISOString(), isActive: 0 }).where(eq(users.id, buyer.id));
    expect(await rowExists(conv)).toBe(true);

    await sweepDeletedConversations(env);

    expect(await rowExists(conv)).toBe(false);
    expect(await messagesInRoom(conv)).toBe(0);
  });
});
