import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, seedReference, staff } from '../ads/helpers';

let root: { id: string; token: string };
let twManager: { id: string; token: string };

beforeAll(async () => {
  await seedReference();
  root = await staff('ref-root@example.com', { admin: true });
  twManager = await staff('ref-tw@example.com', { regions: ['TW'] });
});

/** The audit rows of one kind (newest last), details parsed. */
async function audits(action: string, targetId?: string | number) {
  const { results } = await env.DB.prepare(
    'SELECT target_type, target_id, actor_id, details FROM audit_events WHERE action = ? ORDER BY rowid',
  )
    .bind(action)
    .all<{ target_type: string; target_id: string; actor_id: string; details: string }>();
  return results
    .filter((r) => targetId === undefined || r.target_id === String(targetId))
    .map((r) => ({ ...r, meta: JSON.parse(r.details) }));
}

describe('reference-data writes leave an audit trail', () => {
  it('schools: create, patch (before/after), delete', async () => {
    const res = await call('/api/v1/admin/schools', {
      token: root.token,
      body: { name: 'Audit Uni', email_domain: 'audit.edu.tw', region: 'TW' },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect(await audits('admin.school_created', id)).toHaveLength(1);

    const patch = await call(`/api/v1/admin/schools/${id}`, { token: root.token, method: 'PATCH', body: { name: 'Audit University' } });
    expect(patch.status).toBe(200);
    const [upd] = await audits('admin.school_updated', id);
    expect(upd.actor_id).toBe(root.id);
    expect(upd.meta.changes).toEqual({ name: { before: 'Audit Uni', after: 'Audit University' } });

    expect((await call(`/api/v1/admin/schools/${id}`, { token: root.token, method: 'DELETE' })).status).toBe(204);
    const [del] = await audits('admin.school_deleted', id);
    expect(del.meta).toMatchObject({ name: 'Audit University', email_domain: 'audit.edu.tw' });
  });

  it('schools bulk apply: one summary row; a dry run writes none', async () => {
    const items = [{ email_domain: 'bulk-audit.edu.tw', name: 'Bulk Audit' }];
    await call('/api/v1/admin/schools/bulk?region=TW', { token: root.token, body: { action: 'preview', items } });
    expect(await audits('admin.schools_bulk_applied')).toHaveLength(0);
    const res = await call('/api/v1/admin/schools/bulk?region=TW', { token: root.token, body: { action: 'apply', items } });
    expect(res.status).toBe(200);
    const [row] = await audits('admin.schools_bulk_applied', 'TW');
    expect(row.meta.created).toEqual([expect.objectContaining({ email_domain: 'bulk-audit.edu.tw' })]);
  });

  it('categories: create, patch, delete', async () => {
    const res = await call('/api/v1/admin/categories', { token: root.token, body: { slug: 'audit-cat', title: 'Audit', region: 'TW' } });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect(await audits('admin.category_created', id)).toHaveLength(1);

    await call(`/api/v1/admin/categories/${id}`, { token: root.token, method: 'PATCH', body: { title: 'Audited', sort_order: 3 } });
    const [upd] = await audits('admin.category_updated', id);
    expect(upd.meta.changes).toEqual({ title: { before: 'Audit', after: 'Audited' }, sortOrder: { before: 0, after: 3 } });

    await call(`/api/v1/admin/categories/${id}`, { token: root.token, method: 'DELETE' });
    expect(await audits('admin.category_deleted', id)).toHaveLength(1);
  });

  it('regions and currencies: create and update', async () => {
    const cur = await call('/api/v1/admin/currencies', { token: root.token, body: { code: 'JPY', symbol: 'JP¥', decimal_places: 0 } });
    expect(cur.status).toBe(201);
    expect(await audits('admin.currency_created', 'JPY')).toHaveLength(1);
    await call('/api/v1/admin/currencies/JPY', { token: root.token, method: 'PATCH', body: { symbol: '¥' } });
    const [cu] = await audits('admin.currency_updated', 'JPY');
    expect(cu.meta.changes).toEqual({ symbol: { before: 'JP¥', after: '¥' } });

    const reg = await call('/api/v1/admin/regions', {
      token: root.token,
      body: {
        code: 'JP',
        name: 'Japan',
        currency: 'JPY',
        default_language: 'en',
        languages: ['en'],
        translations: { en: { name: 'Japan' } },
      },
    });
    expect(reg.status).toBe(201);
    expect(await audits('admin.region_created', 'JP')).toHaveLength(1);
    await call('/api/v1/admin/regions/JP', { token: root.token, method: 'PATCH', body: { name: 'Nippon' } });
    const [ru] = await audits('admin.region_updated', 'JP');
    expect(ru.meta.changes).toEqual({ name: { before: 'Japan', after: 'Nippon' } });
  });
});

describe('scope is checked before anything reveals another region', () => {
  it('create answers 403 for a region the staff do not manage, whatever already exists there', async () => {
    // hku.hk exists in HK: a uniqueness check first would answer 400 instead.
    const school = await call('/api/v1/admin/schools', {
      token: twManager.token,
      body: { name: 'Probe', email_domain: 'hku.hk', region: 'HK' },
    });
    expect(school.status).toBe(403);

    await call('/api/v1/admin/categories', { token: root.token, body: { slug: 'hk-only', title: 'HK', region: 'HK' } });
    const cat = await call('/api/v1/admin/categories', {
      token: twManager.token,
      body: { slug: 'hk-only', title: 'Probe', region: 'HK' },
    });
    expect(cat.status).toBe(403);
  });

  it('bulk reports out-of-scope items by index, not by name', async () => {
    const res = await call('/api/v1/admin/schools/bulk?region=TW', {
      token: twManager.token,
      body: {
        action: 'preview',
        items: [
          { email_domain: 'hku.hk', name: 'Exists elsewhere' },
          { email_domain: 'fresh-scope.edu.tw', name: 'Fresh' },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forbidden: unknown[]; new: unknown[] };
    expect(body.forbidden).toEqual([{ index: 0 }]);
    expect(body.new).toHaveLength(1);
  });
});

describe("a region manager's school domains stay clear of other regions' schools", () => {
  // HKU (hku.hk) is an HK school; campus matching picks the most specific domain in any region.
  it("create and patch refuse a domain under or above another region's school", async () => {
    for (const email_domain of ['connect.hku.hk', 'mail.connect.hku.hk']) {
      const res = await call('/api/v1/admin/schools', { token: twManager.token, body: { name: 'Grab', email_domain, region: 'TW' } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.fields).toEqual({ email_domain: ['admin.errSchoolDomainOverlaps'] });
    }
    const ok = await call('/api/v1/admin/schools', {
      token: twManager.token,
      body: { name: 'Own', email_domain: 'own-scope.edu.tw', region: 'TW' },
    });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: number };
    const moved = await call(`/api/v1/admin/schools/${id}`, {
      method: 'PATCH',
      token: twManager.token,
      body: { email_domain: 'staff.hku.hk' },
    });
    expect(moved.status).toBe(400);
    expect(((await moved.json()) as any).error.fields).toEqual({ email_domain: ['admin.errSchoolDomainOverlaps'] });

    // A superuser is not limited.
    const root_ = await call('/api/v1/admin/schools', {
      token: root.token,
      body: { name: 'Root', email_domain: 'connect.hku.hk', region: 'TW' },
    });
    expect(root_.status).toBe(201);
  });

  it('bulk reports an overlapping item by index', async () => {
    const res = await call('/api/v1/admin/schools/bulk?region=TW', {
      token: twManager.token,
      body: { action: 'preview', items: [{ email_domain: 'alumni.hku.hk', name: 'Grab' }] },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('admin.errAllRegionsForbidden');
  });
});

describe('bulk import validation', () => {
  const bulk = (path: string, items: unknown) =>
    call(`/api/v1/admin/${path}/bulk?region=TW`, { token: root.token, body: { action: 'preview', items } });

  it('schools: caps the file, validates each item, and refuses repeated domains', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ email_domain: `m${i}.edu.tw`, name: 'M' }));
    const big = await bulk('schools', many);
    expect(big.status).toBe(400);
    expect(await big.json()).toMatchObject({ error: { code: 'admin.errTooManyItems', max: 500 } });

    const bad = await bulk('schools', [
      { email_domain: 'ok-one.edu.tw', name: 'x'.repeat(256) },
      { email_domain: 'gmail.com', name: 'Free mail' },
      { email_domain: 'ok-two.edu.tw', name: 'Fine', translations: ['nope'] },
      'not an object',
    ]);
    expect(bad.status).toBe(400);
    const { error } = (await bad.json()) as { error: { items: { index: number; errors: Record<string, string[]> }[] } };
    expect(error.items.map((i) => i.index)).toEqual([0, 1, 2, 3]);
    expect(error.items[0].errors).toEqual({ name: ['admin.errInvalidField'] });

    const dup = await bulk('schools', [
      { email_domain: 'twice.edu.tw', name: 'One' },
      { email_domain: '@TWICE.edu.tw', name: 'Two' },
    ]);
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ error: { items: [{ index: 1, errors: { email_domain: ['admin.errInvalidField'] } }] } });
  });

  it('schools: a lowercase item region matches the current region', async () => {
    const res = await bulk('schools', [{ email_domain: 'lower-region.edu.tw', name: 'Lower', region: 'tw' }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new: unknown[]; forbidden: unknown[] };
    expect(body.new).toHaveLength(1);
    expect(body.forbidden).toEqual([]);
  });

  it('categories: validates items, refuses repeated slugs, and allows a slug that exists in another region', async () => {
    await call('/api/v1/admin/categories', { token: root.token, body: { slug: 'shared-slug', title: 'HK', region: 'HK' } });
    const ok = await bulk('categories', [{ slug: 'shared-slug', title: 'TW copy' }]);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ new: [{ slug: 'shared-slug' }], forbidden: [] });

    const bad = await bulk('categories', [
      { slug: 'bad slug!', title: 'x' },
      { slug: 'a', title: 'A' },
      { slug: 'a', title: 'A2' },
    ]);
    expect(bad.status).toBe(400);
    const { error } = (await bad.json()) as { error: { items: { index: number }[] } };
    expect(error.items.map((i) => i.index)).toEqual([0, 2]);

    const many = Array.from({ length: 501 }, (_, i) => ({ slug: `s${i}`, title: 'S' }));
    expect(await (await bulk('categories', many)).json()).toMatchObject({ error: { code: 'admin.errTooManyItems' } });
  });
});

describe('book source while pending review', () => {
  const seedBook = async (reviewed: boolean) => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO books (id, region_code, title, source, reviewed_at, created_at) VALUES (?, 'TW', 'Pending Book', 'manual', ?, ?)",
    )
      .bind(id, reviewed ? new Date().toISOString() : null, new Date().toISOString())
      .run();
    return id;
  };

  it('refuses to move a pending book off manual; confirm-manual still works', async () => {
    const id = await seedBook(false);
    const res = await call(`/api/v1/admin/books/${id}`, { token: root.token, method: 'PATCH', body: { source: 'google_api' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.errInvalidField' } });
    // Same value and other fields stay editable.
    const ok = await call(`/api/v1/admin/books/${id}`, {
      token: root.token,
      method: 'PATCH',
      body: { source: 'manual', title: 'Renamed' },
    });
    expect(ok.status).toBe(200);
    expect((await call(`/api/v1/admin/books/${id}/confirm-manual`, { token: root.token, body: {} })).status).toBe(200);
  });

  it('lets a confirmed book change source', async () => {
    const id = await seedBook(true);
    const res = await call(`/api/v1/admin/books/${id}`, { token: root.token, method: 'PATCH', body: { source: 'google_api' } });
    expect(res.status).toBe(200);
  });
});

describe('regions and currencies are admin-only', () => {
  it('refuses a region manager on the collection and item paths', async () => {
    for (const path of ['/api/v1/admin/regions', '/api/v1/admin/regions/TW', '/api/v1/admin/currencies', '/api/v1/admin/currencies/TWD']) {
      expect((await call(path, { token: twManager.token })).status, path).toBe(403);
      expect((await call(path, { token: root.token })).status, path).toBe(200);
    }
    expect((await call('/api/v1/admin/regions/TW', { token: twManager.token, method: 'PATCH', body: { is_active: false } })).status).toBe(
      403,
    );
  });
});
