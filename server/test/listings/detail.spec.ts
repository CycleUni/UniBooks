import { describe, it, expect, beforeAll } from 'vitest';
import { api, hasMessagingSchema, seedListing, seedRegion, seedUser } from '../messaging/helpers';

const ready = await hasMessagingSchema();

describe.skipIf(!ready)('listing detail', () => {
  beforeAll(() => seedRegion());

  it('a taken-down listing is a 404 to everyone but its seller and staff', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const stranger = await seedUser({ verifiedIn: 'TW' });
    const moderator = await seedUser({ role: 'staff' });
    const removed = await seedListing(seller.id, 'TW', 'removed');
    const sold = await seedListing(seller.id, 'TW', 'sold');
    const get = (id: string, token?: string) => api(`/api/v1/listings/${id}?region=TW`, { token });

    expect((await get(removed)).status).toBe(404);
    expect((await get(removed, stranger.token)).status).toBe(404);
    expect((await get(removed, seller.token)).status).toBe(200);
    expect((await get(removed, moderator.token)).status).toBe(200);
    // Sold stays readable: orders and chats still point at it.
    expect((await get(sold)).status).toBe(200);
  });
});
