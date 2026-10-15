import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { ad, advertiser, call, seedReference, staff } from './helpers';
import { canWrite } from '../../src/routes/admin/ads';

let manager: { id: string; token: string };
let admin: { id: string; token: string };

beforeAll(async () => {
  await seedReference();
  manager = await staff('tw-manager@example.com', { regions: ['TW'] });
  admin = await staff('root@example.com', { admin: true });
});

/** An own tmp upload, as resolveAdImage requires for a new ad. */
async function upload(userId: string): Promise<string> {
  const name = `${crypto.randomUUID().replace(/-/g, '')}.png`;
  await env.R2.put(`tmp/ads/${userId}/${name}`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return `${env.R2_PUBLIC_URL}/tmp/ads/${userId}/${name}`;
}

const newAd = async (userId: string, advertiserId: number) => ({
  advertiser: advertiserId,
  title: 'New',
  image_url: await upload(userId),
  target_url: 'https://shop.example.com/',
  start_date: new Date(Date.now() - 3600_000).toISOString(),
  end_date: new Date(Date.now() + 86_400_000).toISOString(),
});

describe('canWrite', () => {
  it('lets a manager write only advertisers wholly inside their regions', () => {
    expect(canWrite(null, true, [])).toBe(true);
    expect(canWrite(['TW'], true, [])).toBe(false);
    expect(canWrite(['TW'], false, [])).toBe(false);
    expect(canWrite(['TW'], false, ['TW', 'HK'])).toBe(false);
    expect(canWrite(['TW'], false, ['TW'])).toBe(true);
  });
});

describe('H-1: region managers and advertisers they do not own', () => {
  it('can read but not modify a global advertiser or its ads', async () => {
    const global = await advertiser({ name: 'Global', allRegions: true });
    const gAd = await ad(global);
    const t = manager.token;
    expect((await call(`/api/v1/admin/sponsors/${global}`, { token: t })).status).toBe(200);
    expect((await call(`/api/v1/admin/promotions/${gAd}`, { token: t })).status).toBe(200);
    expect((await call(`/api/v1/admin/sponsors/${global}`, { token: t, method: 'PATCH', body: { company_name: 'Hijacked' } })).status).toBe(
      403,
    );
    expect((await call(`/api/v1/admin/sponsors/${global}`, { token: t, method: 'DELETE' })).status).toBe(403);
    expect((await call(`/api/v1/admin/promotions/${gAd}`, { token: t, method: 'PATCH', body: { title: 'Hijacked' } })).status).toBe(403);
    expect((await call(`/api/v1/admin/promotions/${gAd}`, { token: t, method: 'DELETE' })).status).toBe(403);
    expect((await call('/api/v1/admin/promotions', { token: t, body: await newAd(manager.id, global) })).status).toBe(403);

    const row = await env.DB_ADS.prepare('SELECT company_name FROM advertisers WHERE id = ?')
      .bind(global)
      .first<{ company_name: string }>();
    expect(row?.company_name).toBe('Global');
    expect(await env.DB_ADS.prepare('SELECT id FROM ads WHERE id = ?').bind(gAd).first()).not.toBeNull();
  });

  it('cannot modify an advertiser that also runs in a region they do not manage', async () => {
    const mixed = await advertiser({ name: 'Mixed', regions: ['TW', 'HK'] });
    const mAd = await ad(mixed);
    const t = manager.token;
    expect((await call(`/api/v1/admin/sponsors/${mixed}`, { token: t })).status).toBe(200);
    expect((await call(`/api/v1/admin/sponsors/${mixed}`, { token: t, method: 'PATCH', body: { regions: ['TW'] } })).status).toBe(403);
    expect((await call(`/api/v1/admin/promotions/${mAd}`, { token: t, method: 'PATCH', body: { title: 'x' } })).status).toBe(403);
    expect((await call('/api/v1/admin/promotions', { token: t, body: await newAd(manager.id, mixed) })).status).toBe(403);
  });

  it('may modify an own-region advertiser, but not widen it', async () => {
    const own = await advertiser({ name: 'Own', regions: ['TW'] });
    const oAd = await ad(own);
    const t = manager.token;
    expect((await call(`/api/v1/admin/sponsors/${own}`, { token: t, method: 'PATCH', body: { company_name: 'Own 2' } })).status).toBe(200);
    expect((await call(`/api/v1/admin/sponsors/${own}`, { token: t, method: 'PATCH', body: { regions: ['TW', 'HK'] } })).status).toBe(403);
    expect((await call(`/api/v1/admin/sponsors/${own}`, { token: t, method: 'PATCH', body: { all_regions: true } })).status).toBe(403);
    expect((await call(`/api/v1/admin/promotions/${oAd}`, { token: t, method: 'PATCH', body: { title: 'Edited' } })).status).toBe(200);
    // Moving an own ad under a global advertiser is a write to that advertiser too.
    const global = await advertiser({ allRegions: true });
    expect((await call(`/api/v1/admin/promotions/${oAd}`, { token: t, method: 'PATCH', body: { advertiser: global } })).status).toBe(403);
    const created = await call('/api/v1/admin/promotions', { token: t, body: await newAd(manager.id, own) });
    expect(created.status).toBe(201);
    const json = (await created.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ views_count: 0, clicks_count: 0, stats_available: false });
    expect((await call(`/api/v1/admin/promotions/${json.id}`, { token: t, method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/v1/admin/sponsors/${own}`, { token: t, method: 'DELETE' })).status).toBe(204);
  });

  it('cannot create a global advertiser or one outside their regions', async () => {
    const t = manager.token;
    const base = { company_name: 'New', contact_email: 'n@example.com' };
    expect((await call('/api/v1/admin/sponsors', { token: t, body: { ...base, all_regions: true } })).status).toBe(403);
    expect((await call('/api/v1/admin/sponsors', { token: t, body: { ...base, regions: ['HK'] } })).status).toBe(403);
    expect((await call('/api/v1/admin/sponsors', { token: t, body: { ...base, regions: ['TW'] } })).status).toBe(201);
  });

  it('leaves admins unrestricted', async () => {
    const global = await advertiser({ allRegions: true });
    const gAd = await ad(global);
    const t = admin.token;
    expect((await call(`/api/v1/admin/sponsors/${global}`, { token: t, method: 'PATCH', body: { company_name: 'Renamed' } })).status).toBe(
      200,
    );
    expect((await call(`/api/v1/admin/promotions/${gAd}`, { token: t, method: 'PATCH', body: { title: 'Renamed' } })).status).toBe(200);
    expect((await call('/api/v1/admin/promotions', { token: t, body: await newAd(admin.id, global) })).status).toBe(201);
    expect((await call(`/api/v1/admin/sponsors/${global}`, { token: t, method: 'DELETE' })).status).toBe(204);
  });
});

describe('admin ad list numbers', () => {
  it('fills views_count / clicks_count (0 without the SQL API) for each row', async () => {
    const adv = await advertiser({ regions: ['TW'] });
    await ad(adv);
    const res = await call(`/api/v1/admin/promotions?advertiser_id=${adv}`, { token: admin.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Record<string, unknown>[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ views_count: 0, clicks_count: 0, stats_available: false });
  });

  it("shows each ad's reach: its advertiser's regions, or all regions", async () => {
    const regional = await advertiser({ regions: ['TW'] });
    await ad(regional);
    const listed = async (adv: number) =>
      (
        (await (await call(`/api/v1/admin/promotions?advertiser_id=${adv}`, { token: admin.token })).json()) as {
          results: Record<string, unknown>[];
        }
      ).results[0];
    expect(await listed(regional)).toMatchObject({ all_regions: false, regions: ['TW'] });
    const global = await advertiser({ allRegions: true });
    await ad(global);
    expect(await listed(global)).toMatchObject({ all_regions: true });
  });
});

describe('public list cache', () => {
  it('serves the cached list until an admin write bumps ads:ver', async () => {
    const adv = await advertiser({ name: 'Cached Co', regions: ['TW'] });
    const id = await ad(adv, { title: 'Before' });
    const titles = async () =>
      (
        (await (await call('/api/v1/promotions/active?position=home_banner')).json()) as { results: { id: number; title: string }[] }
      ).results
        .filter((r) => r.id === id)
        .map((r) => r.title);
    expect(await titles()).toEqual(['Before']);
    // A change behind the API's back stays invisible: the list is cached.
    await env.DB_ADS.prepare("UPDATE ads SET title = 'Sneaky' WHERE id = ?").bind(id).run();
    expect(await titles()).toEqual(['Before']);
    // An admin write invalidates it.
    const res = await call(`/api/v1/admin/promotions/${id}`, { token: admin.token, method: 'PATCH', body: { title: 'After' } });
    expect(res.status).toBe(200);
    expect(await titles()).toEqual(['After']);
    // So does an advertiser write (deactivating hides its ads).
    expect((await call(`/api/v1/admin/sponsors/${adv}`, { token: admin.token, method: 'PATCH', body: { is_active: false } })).status).toBe(
      200,
    );
    expect(await titles()).toEqual([]);
  });
});
