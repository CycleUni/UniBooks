import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, seedRegion, seedUser } from '../messaging/helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('admin ad image uploads', () => {
  beforeAll(() => seedRegion());

  it('issues a same-origin upload URL, stores matching bytes once, and binds the token to its staff member', async () => {
    const staff = await seedUser({ role: 'admin' });
    const other = await seedUser({ role: 'admin' });
    const ticket = await api('/api/v1/admin/promotions/uploads', {
      method: 'POST',
      token: staff.token,
      body: JSON.stringify({ content_type: 'image/png', content_length: PNG.byteLength }),
    });
    expect(ticket.status).toBe(200);
    const { upload_url, photo_url } = (await ticket.json()) as { upload_url: string; photo_url: string };
    const url = new URL(upload_url);
    expect(url.pathname).toBe('/api/v1/admin/promotions/uploads/file');
    const path = url.pathname + url.search;
    const put = (token: string, body: BodyInit, type = 'image/png') =>
      api(path, { method: 'PUT', token, headers: { 'Content-Type': type }, body });

    expect((await put(other.token, PNG)).status).toBe(403); // someone else's token
    expect((await put(staff.token, '<svg/>')).status).toBe(400); // not a PNG
    expect((await put(staff.token, PNG, 'image/gif')).status).toBe(400); // wrong declared type
    expect((await put(staff.token, PNG)).status).toBe(200);
    const key = photo_url.split('/').slice(-4).join('/');
    expect(key).toMatch(new RegExp(`^tmp/ads/${staff.id}/[0-9a-f]{32}\\.png$`));
    expect((await env.R2.get(key))?.httpMetadata?.contentType).toBe('image/png');
    const replay = await put(staff.token, PNG);
    expect(replay.status).toBe(409); // no overwrite
    expect(await replay.json()).toEqual({ error: { code: 'upload.errTokenUsed' } });
  });

  it('refuses a non-image type when issuing', async () => {
    const staff = await seedUser({ role: 'admin' });
    const res = await api('/api/v1/admin/promotions/uploads', {
      method: 'POST',
      token: staff.token,
      body: JSON.stringify({ content_type: 'image/svg+xml', content_length: 10 }),
    });
    expect(res.status).toBe(400);
  });
});
