import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, createUser, seedReference } from '../accounts/helpers';
import { tokenFor } from '../ads/helpers';
import { deleteUnusedBooks, UNUSED_BOOK_GRACE_MS } from '../../src/services/catalog/unused';

let userId: string;
let token: string;

beforeAll(async () => {
  await seedReference();
  userId = await createUser('unused-books@example.com');
  token = await tokenFor(userId);
});

const old = () => new Date(Date.now() - UNUSED_BOOK_GRACE_MS - 60_000).toISOString();

async function seedBook(createdAt = old(), coverR2Key: string | null = null) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO books (id, region_code, title, source, cover_r2_key, created_at) VALUES (?, 'TW', 'Unused?', 'manual', ?, ?)",
  )
    .bind(id, coverR2Key, createdAt)
    .run();
  return id;
}

async function listOn(bookId: string, status: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO listings (id, region_code, currency_code, book_id, seller_id, price, condition, status, created_at, updated_at)
     VALUES (?, 'TW', 'TWD', ?, ?, 100, 'new', ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), bookId, userId, status, now, now)
    .run();
}

async function request(bookId: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO subscriptions (id, region_code, user_id, book_id, created_at) VALUES (?, 'TW', ?, ?, ?)")
    .bind(id, userId, bookId, new Date().toISOString())
    .run();
  return id;
}

const exists = async (bookId: string) => !!(await env.DB.prepare('SELECT id FROM books WHERE id = ?').bind(bookId).first());

describe('deleting unused books', () => {
  it('deletes a book with no listing and no request, and its R2 cover', async () => {
    const id = crypto.randomUUID();
    const book = await seedBook(old(), `covers/${id}.jpg`);
    await env.R2.put(`covers/${id}.jpg`, new Uint8Array([1]));
    expect(await deleteUnusedBooks(env, [book])).toBe(1);
    expect(await exists(book)).toBe(false);
    expect(await env.R2.get(`covers/${id}.jpg`)).toBeNull();
  });

  it('keeps a fresh book a seller may still be listing', async () => {
    const book = await seedBook(new Date().toISOString());
    expect(await deleteUnusedBooks(env, [book])).toBe(0);
    expect(await exists(book)).toBe(true);
  });

  it('keeps a book with a request or with a listing in any status', async () => {
    const requested = await seedBook();
    await request(requested);
    const sold = await seedBook();
    await listOn(sold, 'sold');
    const removed = await seedBook();
    await listOn(removed, 'removed');
    expect(await deleteUnusedBooks(env, [requested, sold, removed])).toBe(0);
  });
});

describe('cancelling a request', () => {
  it('deletes the book once its last request is gone', async () => {
    const book = await seedBook();
    const sub = await request(book);
    const res = await call(`/api/v1/subscriptions/${sub}`, { method: 'DELETE', token, headers: { 'X-Region': 'TW' } });
    expect(res.status).toBe(204);
    expect(await exists(book)).toBe(false);
  });

  it('keeps the book while it is still listed', async () => {
    const book = await seedBook();
    await listOn(book, 'active');
    const sub = await request(book);
    await call(`/api/v1/subscriptions/${sub}`, { method: 'DELETE', token, headers: { 'X-Region': 'TW' } });
    expect(await exists(book)).toBe(true);
  });
});
