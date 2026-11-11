import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, hasMessagingSchema, seedListing, seedRegion, seedUser } from '../messaging/helpers';
import { LIMITS } from '../../src/lib/limits';

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

describe.skipIf(!ready)('editing a reserved or sold listing', () => {
  beforeAll(() => seedRegion());

  it('keeps what the buyer agreed to while reserved, and everything but the note once sold', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const patch = (id: string, body: Record<string, unknown>) =>
      api(`/api/v1/listings/${id}?region=TW`, { method: 'PATCH', token: seller.token, body: JSON.stringify(body) });

    const reserved = await seedListing(seller.id, 'TW', 'active');
    await env.DB.prepare("UPDATE listings SET status = 'reserved' WHERE id = ?").bind(reserved).run();
    for (const body of [{ price: 1 }, { condition: 'damaged' }, { photos: [] }]) {
      const res = await patch(reserved, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'listing.errReservedLocked' } });
    }
    expect((await patch(reserved, { description: 'Spine is a bit worn' })).status).toBe(200);

    const sold = await seedListing(seller.id, 'TW', 'sold');
    const soldEdit = await patch(sold, { description: 'changed' });
    expect(soldEdit.status).toBe(409);
    expect(await soldEdit.json()).toEqual({ error: { code: 'listing.errSoldLocked' } });
    expect((await patch(sold, { private_note: 'paid in cash' })).status).toBe(200);
  });
});

describe.skipIf(!ready)('listing field limits', () => {
  beforeAll(() => seedRegion());

  it('enforces price, text limits, and allows existing over-cap price to only stay or lower', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const patch = (id: string, body: Record<string, unknown>) =>
      api(`/api/v1/listings/${id}?region=TW`, { method: 'PATCH', token: seller.token, body: JSON.stringify(body) });

    const listingId = await seedListing(seller.id, 'TW', 'active');

    // 1. price: max 999999
    expect((await patch(listingId, { price: LIMITS.price + 1 })).status).toBe(400);
    expect((await patch(listingId, { price: LIMITS.price })).status).toBe(200);

    // Existing listing above the cap (e.g. 1500000)
    await env.DB.prepare('UPDATE listings SET price = 1500000 WHERE id = ?').bind(listingId).run();
    // may not raise it above 1500000
    expect((await patch(listingId, { price: 1500001 })).status).toBe(400);
    // may keep it
    expect((await patch(listingId, { price: 1500000 })).status).toBe(200);
    // may lower it
    expect((await patch(listingId, { price: 1400000 })).status).toBe(200);

    // 2. course_name: max 100
    expect((await patch(listingId, { course_name: 'a'.repeat(LIMITS.courseName + 1) })).status).toBe(400);
    expect((await patch(listingId, { course_name: 'a'.repeat(LIMITS.courseName) })).status).toBe(200);

    // 3. professor_name: max 100
    expect((await patch(listingId, { professor_name: 'a'.repeat(LIMITS.professorName + 1) })).status).toBe(400);
    expect((await patch(listingId, { professor_name: 'a'.repeat(LIMITS.professorName) })).status).toBe(200);

    // 4. description: max 2000
    expect((await patch(listingId, { description: 'a'.repeat(LIMITS.listingDescription + 1) })).status).toBe(400);
    expect((await patch(listingId, { description: 'a'.repeat(LIMITS.listingDescription) })).status).toBe(200);

    // 5. private_note: max 1000
    expect((await patch(listingId, { private_note: 'a'.repeat(LIMITS.listingPrivateNote + 1) })).status).toBe(400);
    expect((await patch(listingId, { private_note: 'a'.repeat(LIMITS.listingPrivateNote) })).status).toBe(200);

    // 6. book_title via listing PATCH: max 255
    expect((await patch(listingId, { book_title: 'a'.repeat(LIMITS.bookTitle + 1) })).status).toBe(400);
    expect((await patch(listingId, { book_title: 'a'.repeat(LIMITS.bookTitle) })).status).toBe(200);

    // 7. book_authors via listing PATCH: max 512
    expect((await patch(listingId, { book_authors: 'a'.repeat(LIMITS.bookAuthors + 1) })).status).toBe(400);
    expect((await patch(listingId, { book_authors: 'a'.repeat(LIMITS.bookAuthors) })).status).toBe(200);
  });
});
