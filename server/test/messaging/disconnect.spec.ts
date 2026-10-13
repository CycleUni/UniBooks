import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, hasMessagingSchema, seedConversation, seedListing, seedRegion, seedUser } from './helpers';
import { mintChatToken, mintHubToken } from '../../src/services/chatTokens';
import { disconnectUser } from '../../src/services/messaging/disconnect';

const ready = await hasMessagingSchema();

/** Open a socket through the Worker and resolve with its close code. */
async function open(path: string, token: string): Promise<{ closed: Promise<number> }> {
  const res = await api(path, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': token } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return { closed: new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code))) };
}

describe.skipIf(!ready)('disabling an account closes its chat sockets', () => {
  beforeAll(() => seedRegion());

  it('closes the hub and the room sockets with 4003, and leaves the other party connected', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    const participants = [buyer.id, seller.id];

    const hub = await open('/api/chat/hub', await mintHubToken(env, buyer.id));
    const room = await open(
      `/api/chat/rooms/${conv}`,
      await mintChatToken(env, { userId: buyer.id, roomId: conv, participantIds: participants, role: 'user' }),
    );
    const other = await open(
      `/api/chat/rooms/${conv}`,
      await mintChatToken(env, { userId: seller.id, roomId: conv, participantIds: participants, role: 'user' }),
    );

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
