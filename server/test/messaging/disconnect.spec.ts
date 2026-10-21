import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, hasMessagingSchema, seedConversation, seedListing, seedRegion, seedUser } from './helpers';
import { mintChatToken } from '../../src/services/chatTokens';
import { disconnectUser } from '../../src/services/messaging/disconnect';
import { signToken } from '../../src/lib/jwt';
import { CHAT_APP_ID, chatRoomStub } from '../../src/lib/chat';
import { deleteListing } from '../../src/services/listings/lifecycle';

const ready = await hasMessagingSchema();

/** Open a socket through the Worker and resolve with its close code. */
async function open(path: string, headers: Record<string, string>): Promise<{ ws: WebSocket; closed: Promise<number>; frames: any[] }> {
  const res = await api(path, { headers: { Upgrade: 'websocket', ...headers } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const frames: any[] = [];
  ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
  return { ws, frames, closed: new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code))) };
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ready)('disabling an account closes its chat sockets', () => {
  beforeAll(() => seedRegion());

  it('closes the hub and the room sockets with 4003, and leaves the other party connected', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    const participants = [buyer.id, seller.id];

    // The hub signs in with the session cookie; rooms with their own token.
    const hub = await open('/api/chat/hub', { Cookie: `__Host-ub_at=${buyer.token}` });
    const room = await open(`/api/chat/rooms/${conv}`, {
      'Sec-WebSocket-Protocol': await mintChatToken(env, { userId: buyer.id, roomId: conv, participantIds: participants, role: 'user' }),
    });
    const other = await open(`/api/chat/rooms/${conv}`, {
      'Sec-WebSocket-Protocol': await mintChatToken(env, { userId: seller.id, roomId: conv, participantIds: participants, role: 'user' }),
    });

    await disconnectUser(env, buyer.id);
    expect(await hub.closed).toBe(4003);
    expect(await room.closed).toBe(4003);
    const stillOpen = await Promise.race([other.closed, new Promise((r) => setTimeout(() => r('open'), 200))]);
    expect(stillOpen).toBe('open');
  });
});

describe.skipIf(!ready)('observer tokens', () => {
  beforeAll(() => seedRegion());

  it("read a reported room only while the staff member manages the room's region", async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    const read = async (userId: string) => {
      const tok = await mintChatToken(env, { userId, roomId: conv, participantIds: [buyer.id, seller.id], role: 'observer' });
      return (await api(`/api/chat/rooms/${conv}/messages`, { headers: { Authorization: `Bearer ${tok}` } })).status;
    };
    expect(await read((await seedUser({ role: 'staff' })).id)).toBe(403); // manages no region
    expect(await read((await seedUser({ role: 'admin' })).id)).toBe(200);
    expect(await read((await seedUser()).id)).toBe(403);
  });
});

describe.skipIf(!ready)('room sockets', () => {
  beforeAll(() => seedRegion());

  it('a socket that only listens is closed with 4001 when its token expires', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    const short = await signToken(
      'chat',
      { user_id: buyer.id, room_id: conv, app_id: CHAT_APP_ID, participant_ids: [buyer.id, seller.id], role: 'user' },
      env,
      '1s',
    );
    const room = await open(`/api/chat/rooms/${conv}`, { 'Sec-WebSocket-Protocol': short });
    // The room's alarm fires at the token's expiry (or now, if the runtime has not run it yet).
    await settle(1100);
    const { runDurableObjectAlarm } = await import('cloudflare:test');
    await runDurableObjectAlarm(chatRoomStub(env, conv) as unknown as DurableObjectStub);
    const code = await Promise.race([room.closed, settle(2000).then(() => 'open')]);
    expect(code).toBe(4001);
  });

  it('deleting the listing makes sockets already open read-only', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const listing = await seedListing(seller.id);
    const conv = await seedConversation(buyer.id, seller.id, listing);
    const room = await open(`/api/chat/rooms/${conv}`, {
      'Sec-WebSocket-Protocol': await mintChatToken(env, {
        userId: buyer.id,
        roomId: conv,
        participantIds: [buyer.id, seller.id],
        role: 'user',
      }),
    });
    const row = await env.DB.prepare('SELECT id, book_id, seller_id, photos FROM listings WHERE id = ?').bind(listing).first<any>();
    await deleteListing(env, 'http://localhost', { id: row.id, bookId: row.book_id, sellerId: row.seller_id, photos: row.photos ?? '[]' });
    await settle();
    expect(room.frames).toContainEqual({ type: 'read_only' });

    room.ws.send(JSON.stringify({ type: 'message', content: 'still here?' }));
    await settle();
    expect(room.frames.some((f) => f.type === 'error' && f.code === 'READ_ONLY_TOKEN')).toBe(true);
    expect(room.frames.some((f) => f.type === 'ack')).toBe(false);
  });
});
