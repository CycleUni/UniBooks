import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { books, createDb } from '../../src/db';
import { app, call, seedReference, staff, tokenFor } from '../ads/helpers';
import { createUser } from '../accounts/helpers';
import { runCoverCleanup } from '../../src/services/catalog/covers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('admin book cover uploads', () => {
  let root: { id: string; token: string };
  let twManager: { id: string; token: string };
  let normalUserToken: string;

  beforeAll(async () => {
    await seedReference();
    root = await staff('book-root@example.com', { admin: true });
    twManager = await staff('book-tw@example.com', { regions: ['TW'] });
    const normalUserId = await createUser('normal-user@example.com', { role: 'user' });
    normalUserToken = await tokenFor(normalUserId);
  });

  async function seedTestBook(regionCode = 'TW', coverUrl = '') {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await createDb(env.DB).insert(books).values({
      id,
      regionCode,
      title: 'Test Book For Cover',
      source: 'manual',
      coverUrl,
      createdAt: now,
    });
    return id;
  }

  function putBytes(urlStr: string, token: string, bytes: Uint8Array, contentType = 'image/png') {
    const url = new URL(urlStr);
    const req = new Request(`http://x${url.pathname}${url.search}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
      },
      body: bytes,
    });
    return app.fetch(req, env);
  }

  it('rejects non-staff with 403', async () => {
    const bookId = await seedTestBook('TW');
    const res = await call('/api/v1/admin/books/uploads', {
      token: normalUserToken,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength, book_id: bookId },
    });
    expect(res.status).toBe(403);
  });

  it('rejects out-of-scope region staff on upload (403) and save (404, like every book route)', async () => {
    const hkBookId = await seedTestBook('HK');

    // Upload attempt with book_id from out-of-scope region
    const uploadRes = await call('/api/v1/admin/books/uploads', {
      token: twManager.token,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength, book_id: hkBookId },
    });
    expect(uploadRes.status).toBe(403);
    expect(await uploadRes.json()).toMatchObject({ error: { code: 'admin.errRegionForbidden' } });

    // Upload attempt via /books/:id/uploads for out-of-scope region
    const uploadRes2 = await call(`/api/v1/admin/books/${hkBookId}/uploads`, {
      token: twManager.token,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength },
    });
    expect(uploadRes2.status).toBe(403);

    // Edit attempt for out-of-scope region
    const editRes = await call(`/api/v1/admin/books/${hkBookId}`, {
      token: twManager.token,
      method: 'PATCH',
      body: { title: 'New HK Title' },
    });
    expect(editRes.status).toBe(404);
  });

  it('completes upload → save → served cover URL, and promotes to covers/custom/...', async () => {
    const bookId = await seedTestBook('TW');

    // 1. Issue upload
    const ticketRes = await call('/api/v1/admin/books/uploads', {
      token: root.token,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength, book_id: bookId },
    });
    expect(ticketRes.status).toBe(200);
    const { upload_url, photo_url } = (await ticketRes.json()) as { upload_url: string; photo_url: string };
    expect(upload_url).toContain('/api/v1/admin/books/uploads/file?token=');

    // 2. PUT the file bytes
    const putRes = await putBytes(upload_url, root.token, PNG, 'image/png');
    expect(putRes.status).toBe(200);

    // Verify temp object exists
    const tmpKey = photo_url.split('/').slice(-4).join('/');
    expect(tmpKey).toMatch(new RegExp(`^tmp/covers/${root.id}/[0-9a-f]{32}\\.png$`));
    expect(await env.R2.get(tmpKey)).not.toBeNull();

    // 3. Save book with cover_url = photo_url
    const saveRes = await call(`/api/v1/admin/books/${bookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { cover_url: photo_url },
    });
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as { book: { cover_url: string } };

    // The temporary object was deleted
    expect(await env.R2.get(tmpKey)).toBeNull();

    // The permanent object was created under covers/custom/
    const [row] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(row.coverR2Key).toMatch(new RegExp(`^covers/custom/${bookId}-[0-9a-f]{32}\\.png$`));
    expect(await env.R2.get(row.coverR2Key!)).not.toBeNull();

    // The served cover_url is that object under whatever base serves the
    // bucket: /api/media locally, the public R2 domain where one is configured (CI).
    expect(saved.book.cover_url.endsWith(`/${row.coverR2Key}`)).toBe(true);

    // GET detail returns the served cover URL
    const getRes = await call(`/api/v1/admin/books/${bookId}`, { token: root.token });
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as { cover_url: string };
    expect(detail.cover_url).toBe(saved.book.cover_url);
  });

  it('replaces an existing custom cover and deletes the old one', async () => {
    const bookId = await seedTestBook('TW');

    // First upload
    const t1 = await call('/api/v1/admin/books/uploads', {
      token: root.token,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength, book_id: bookId },
    });
    const { upload_url: u1, photo_url: p1 } = (await t1.json()) as { upload_url: string; photo_url: string };
    await putBytes(u1, root.token, PNG, 'image/png');
    await call(`/api/v1/admin/books/${bookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { cover_url: p1 },
    });

    const [row1] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    const firstKey = row1.coverR2Key!;
    expect(await env.R2.get(firstKey)).not.toBeNull();

    // Second upload (replace)
    const t2 = await call('/api/v1/admin/books/uploads', {
      token: root.token,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength, book_id: bookId },
    });
    const { upload_url: u2, photo_url: p2 } = (await t2.json()) as { upload_url: string; photo_url: string };
    await putBytes(u2, root.token, PNG, 'image/png');
    const save2 = await call(`/api/v1/admin/books/${bookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { cover_url: p2 },
    });
    expect(save2.status).toBe(200);

    const [row2] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(row2.coverR2Key).not.toBe(firstKey);
    expect(await env.R2.get(firstKey)).toBeNull(); // Old cover deleted
    expect(await env.R2.get(row2.coverR2Key!)).not.toBeNull(); // New cover stored
  });

  it('removes a custom cover and cleans up the R2 object', async () => {
    const bookId = await seedTestBook('TW');

    // Upload & save
    const t = await call('/api/v1/admin/books/uploads', {
      token: root.token,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength, book_id: bookId },
    });
    const { upload_url, photo_url } = (await t.json()) as { upload_url: string; photo_url: string };
    await putBytes(upload_url, root.token, PNG, 'image/png');
    await call(`/api/v1/admin/books/${bookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { cover_url: photo_url },
    });

    const [beforeRemove] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    const key = beforeRemove.coverR2Key!;
    expect(await env.R2.get(key)).not.toBeNull();

    // Remove cover
    const removeRes = await call(`/api/v1/admin/books/${bookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { cover_url: '' },
    });
    expect(removeRes.status).toBe(200);

    const [afterRemove] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(afterRemove.coverR2Key).toBeNull();
    expect(afterRemove.coverUrl).toBe('');
    expect(await env.R2.get(key)).toBeNull(); // R2 object was deleted
  });

  it('deletes custom cover when an external cover URL is set by hand', async () => {
    const bookId = await seedTestBook('TW');

    // Upload & save custom cover
    const t = await call('/api/v1/admin/books/uploads', {
      token: root.token,
      method: 'POST',
      body: { content_type: 'image/png', content_length: PNG.byteLength, book_id: bookId },
    });
    const { upload_url, photo_url } = (await t.json()) as { upload_url: string; photo_url: string };
    await putBytes(upload_url, root.token, PNG, 'image/png');
    await call(`/api/v1/admin/books/${bookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { cover_url: photo_url },
    });

    const [beforeUpdate] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    const key = beforeUpdate.coverR2Key!;
    expect(await env.R2.get(key)).not.toBeNull();

    // Set external cover URL by hand
    const external = 'https://books.google.com/custom-test-cover.jpg';
    const updateRes = await call(`/api/v1/admin/books/${bookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { cover_url: external },
    });
    expect(updateRes.status).toBe(200);

    const [afterUpdate] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(afterUpdate.coverR2Key).toBeNull();
    expect(afterUpdate.coverUrl).toBe(external);
    expect(await env.R2.get(key)).toBeNull(); // Orphan deleted
  });

  it('cleanup job leaves a custom cover alone even when book has no active listing', async () => {
    const bookId = await seedTestBook('TW');

    // Directly put custom cover in R2 & DB with covers/custom/...
    const customKey = `covers/custom/${bookId}-test123456.png`;
    await env.R2.put(customKey, PNG);
    await createDb(env.DB).update(books).set({ coverR2Key: customKey }).where(eq(books.id, bookId));

    // Book has NO listings (active or reserved)
    // Run cleanup
    const res = await runCoverCleanup(env);
    expect(res.cleaned).toBe(0);

    // Cover still in R2 and coverR2Key still set
    expect(await env.R2.get(customKey)).not.toBeNull();
    const [row] = await createDb(env.DB).select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(row.coverR2Key).toBe(customKey);
  });

  it('merge keeps target cover and deletes source custom cover', async () => {
    const isbn = '9789860629200';
    const sourceBookId = await seedTestBook('TW');
    const targetBookId = await seedTestBook('TW');

    // Give target a cover and the ISBN
    const targetKey = `covers/custom/${targetBookId}-target.png`;
    await env.R2.put(targetKey, PNG);
    await createDb(env.DB).update(books).set({ isbn13: isbn, coverR2Key: targetKey }).where(eq(books.id, targetBookId));

    // Give source a custom cover
    const sourceKey = `covers/custom/${sourceBookId}-source.png`;
    await env.R2.put(sourceKey, PNG);
    await createDb(env.DB).update(books).set({ coverR2Key: sourceKey }).where(eq(books.id, sourceBookId));

    // Merge source into target
    const mergeRes = await call(`/api/v1/admin/books/${sourceBookId}`, {
      token: root.token,
      method: 'PATCH',
      body: { isbn13: isbn, merge: true },
    });
    expect(mergeRes.status).toBe(200);
    const body = (await mergeRes.json()) as { merged_into: string };
    expect(body.merged_into).toBe(targetBookId);

    // Source custom cover is deleted from R2
    expect(await env.R2.get(sourceKey)).toBeNull();

    // Target cover is preserved in R2 and DB
    expect(await env.R2.get(targetKey)).not.toBeNull();
    const [targetRow] = await createDb(env.DB).select().from(books).where(eq(books.id, targetBookId)).limit(1);
    expect(targetRow.coverR2Key).toBe(targetKey);
  });
});
