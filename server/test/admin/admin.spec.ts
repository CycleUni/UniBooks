import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import {
  CompetitionRank,
  periodStart,
  roundHalfEven,
  SeriesBuckets,
  termIndex,
  termLabel,
  zonedMidnight,
} from '../../src/services/admin/statsTime';
import { resolveAdImage } from '../../src/services/admin/uploads';
import { sniffImage, storageKey as storageKeyFromUrl } from '../../src/lib/media';
import { dedupeCode, deriveCode, isValidCode, normalizeCode } from '../../src/services/admin/schoolCodes';
import { isSafeTargetUrl } from '../../src/routes/admin/ads';

const fetchApi = (path: string, init?: RequestInit) =>
  (exports as any).default.fetch(new Request(`http://x${path}`, init)) as Promise<Response>;

describe('admin stats time math', () => {
  it('puts local midnight at the right UTC instant', () => {
    // Taipei is UTC+8: 2026-10-12 00:00 local = 2026-10-11T16:00Z.
    expect(new Date(zonedMidnight(2026, 10, 12, 'Asia/Taipei')).toISOString()).toBe('2026-10-11T16:00:00.000Z');
  });

  it('starts a 7-day period six local days before today', () => {
    const now = Date.parse('2026-10-12T03:00:00Z'); // 11:00 in Taipei
    expect(periodStart('Asia/Taipei', 7, now)).toBe('2026-10-05T16:00:00.000Z');
    expect(periodStart('Asia/Taipei', 0, now)).toBeNull();
  });

  it('buckets today by hour up to the current one', () => {
    const now = Date.parse('2026-10-12T03:30:00Z'); // 11:30 Taipei
    const b = new SeriesBuckets('Asia/Taipei', 1, now);
    expect(b.unit).toBe('hour');
    expect(b.labels).toHaveLength(12);
    expect(b.keyOf('2026-10-12T02:10:00.000Z')).toBe('10:00');
    expect(b.keyOf('2026-10-11T15:59:00.000Z')).toBeNull();
  });

  it('buckets by local day, zero-filled', () => {
    const now = Date.parse('2026-10-12T03:30:00Z');
    const b = new SeriesBuckets('Asia/Taipei', 7, now);
    expect(b.labels).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    // 17:00Z on the 11th is 01:00 on the 12th in Taipei.
    const g = b.group([{ at: '2026-10-11T17:00:00.000Z' }], (r) => r.at);
    expect(g.get('2026-10-12')).toBe(1);
  });

  it('assigns academic terms', () => {
    expect(termLabel(termIndex(Date.parse('2026-09-01T00:00:00Z'), 'Asia/Taipei'))).toEqual({ year: 2026, season: 'autumn' });
    expect(termLabel(termIndex(Date.parse('2027-01-10T00:00:00Z'), 'Asia/Taipei'))).toEqual({ year: 2026, season: 'autumn' });
    expect(termLabel(termIndex(Date.parse('2027-03-10T00:00:00Z'), 'Asia/Taipei'))).toEqual({ year: 2027, season: 'spring' });
  });

  it('ranks competitively and rounds like Python', () => {
    const r = new CompetitionRank([5, 3, 3, 1, 0]);
    expect([r.rank(5), r.rank(3), r.rank(1), r.rank(0)]).toEqual([1, 2, 4, null]);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
  });
});

describe('ad images and links', () => {
  it('sniffs image types from magic bytes only', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImage(new TextEncoder().encode('GIF89a....'))).toBe('gif');
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<html>'))).toBeNull();
  });

  it('derives keys only from our own storage URLs', () => {
    const e = { ...env, R2_PUBLIC_URL: 'https://media.example.com' } as any;
    expect(storageKeyFromUrl(e, 'http://x', 'https://media.example.com/ads/u/abc.png')).toBe('ads/u/abc.png');
    expect(storageKeyFromUrl(e, 'http://x', 'https://evil.example.com/ads/u/abc.png')).toBeNull();
    expect(storageKeyFromUrl(e, 'http://x', 'https://media.example.com/ads/a%2F..%2F..%2Fx.png')).toBeNull();
    expect(storageKeyFromUrl(e, 'http://x', 'javascript:alert(1)')).toBeNull();
  });

  it("refuses another user's upload, a foreign host, and keys outside tmp/ads", async () => {
    const e = { ...env, R2_PUBLIC_URL: 'https://media.example.com' } as any;
    const name = `${'a'.repeat(32)}.png`;
    await expect(resolveAdImage(e, 'http://x', 'me', `https://media.example.com/tmp/ads/other/${name}`, null)).resolves.toMatchObject({
      ok: false,
      code: 'listing.errPhotoNotOwned',
    });
    await expect(resolveAdImage(e, 'http://x', 'me', `https://cdn.evil.com/tmp/ads/me/${name}`, null)).resolves.toMatchObject({
      ok: false,
      code: 'listing.errPhotoHostNotAllowed',
    });
    await expect(resolveAdImage(e, 'http://x', 'me', `https://media.example.com/listings/me/${name}`, null)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('promotes an own tmp upload to ads/', async () => {
    const e = { ...env, R2_PUBLIC_URL: 'https://media.example.com' } as any;
    const name = `${'b'.repeat(32)}.png`;
    await env.R2.put(`tmp/ads/me/${name}`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const res = await resolveAdImage(e, 'http://x', 'me', `https://media.example.com/tmp/ads/me/${name}`, null);
    expect(res).toMatchObject({ ok: true, url: `https://media.example.com/ads/me/${name}` });
    expect(await env.R2.get(`tmp/ads/me/${name}`)).toBeNull();
    expect(await env.R2.get(`ads/me/${name}`)).not.toBeNull();
  });

  it('only lets ads link to http(s) URLs', () => {
    expect(isSafeTargetUrl('https://shop.example.com/x?y=1')).toBe(true);
    expect(isSafeTargetUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeTargetUrl('data:text/html,hi')).toBe(false);
    expect(isSafeTargetUrl('https://user:pw@example.com/')).toBe(false);
    expect(isSafeTargetUrl('//example.com')).toBe(false);
  });
});

describe('school codes', () => {
  it('normalizes, validates, derives and dedupes', () => {
    expect(normalizeCode(' ntu ')).toBe('NTU');
    expect(isValidCode('NTU-2')).toBe(true);
    expect(isValidCode('N TU')).toBe(false);
    expect(deriveCode('ntu.edu.tw')).toBe('NTU');
    expect(dedupeCode('NTU', new Set(['NTU', 'NTU-2']))).toBe('NTU-3');
  });
});

describe('admin routing', () => {
  it('answers 401 without a session on every admin path', async () => {
    for (const path of [
      '/api/v1/admin/regions/',
      '/api/v1/admin/stats/overview/?region=TW',
      '/api/v1/admin/promotions/',
      '/api/v1/admin/users/',
    ]) {
      const res = await fetchApi(path);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'auth.errNotLoggedIn' } });
    }
    const upload = await fetchApi('/api/v1/admin/promotions/uploads/', { method: 'POST' });
    expect(upload.status).toBe(401);
    const put = await fetchApi('/api/v1/admin/promotions/uploads/file/?token=x', { method: 'PUT', body: 'x' });
    expect(put.status).toBe(401);
  });

  it('404s a non-numeric ad id on the public counters', async () => {
    const res = await fetchApi('/api/v1/promotions/abc/view/', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
