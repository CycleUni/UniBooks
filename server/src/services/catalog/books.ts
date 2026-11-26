/**
 * A book in the region's catalogue for what a client sends ({isbn13, title,
 * authors, publisher, published_date, cover_url, source}): the existing one
 * for its ISBN (its gaps filled, nothing overwritten), else a new one. A
 * claimed catalogue source is checked against that catalogue, and then its
 * title and authors are used; anything else is a 'manual' book, which waits
 * in the admin review queue. Used by the sell flow (POST /books/manual) and
 * by book drive intake.
 */
import { and, eq } from 'drizzle-orm';
import type { Env } from '../../env';
import { createDb, books, type Book, type InsertBook } from '../../db';
import { apiError, fieldErrors } from '../../lib/http';
import { LIMITS } from '../../lib/limits';
import { publicBase } from '../../lib/media';
import { nowIso } from '../../lib/time';
import { validateBookIsbn } from './isbn';
import { cleanCoverUrl, cleanPublisher, isTrustedCoverUrl } from './common';
import { ISBN_LOOKUPS, type BookRecord } from './lookups';

const CLAIMABLE_SOURCES: Record<string, keyof typeof ISBN_LOOKUPS> = {
  google_api: 'googlebooks',
  openlibrary_api: 'openlibrary',
  isbnnet_api: 'isbnnet',
};

/**
 * The catalogue's own record behind a claimed source, or null: anything but
 * 'manual' keeps a book out of the admin review queue, so the claim is
 * checked rather than trusted.
 */
async function vettedCatalogueRecord(env: Env, claimed: unknown, isbn13: string | null): Promise<BookRecord | null> {
  const engine = typeof claimed === 'string' ? CLAIMABLE_SOURCES[claimed] : undefined;
  if (!engine || !isbn13) return null;
  try {
    return await ISBN_LOOKUPS[engine](env, isbn13);
  } catch (e) {
    console.warn('[books] could not vet source', claimed, isbn13, e);
    return null;
  }
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

export async function findOrCreateBook(
  env: Env,
  regionCode: string,
  body: Record<string, unknown>,
  opts: { isAdmin: boolean; origin: string },
): Promise<{ book: Book; created: boolean }> {
  const db = createDb(env.DB);

  let coverUrl = 'cover_url' in body ? cleanCoverUrl(body.cover_url) || '' : undefined;
  // Only admins may point a shared book at an arbitrary host.
  if (coverUrl && !opts.isAdmin && !isTrustedCoverUrl(coverUrl, publicBase(env, opts.origin))) coverUrl = '';

  let isbn13: string | null = null;
  if (body.isbn13 !== undefined && body.isbn13 !== null && body.isbn13 !== '') {
    isbn13 = validateBookIsbn(body.isbn13);
    if (!isbn13) apiError(400, 'listing.errInvalidIsbn');
    const [existing] = await db
      .select()
      .from(books)
      .where(and(eq(books.regionCode, regionCode), eq(books.isbn13, isbn13)))
      .limit(1);
    if (existing) {
      // Fill gaps in the shared record; never overwrite what is there.
      const patch: Partial<InsertBook> = {};
      const publisher = str(body.publisher);
      const published = str(body.published_date);
      if (publisher && publisher.length > LIMITS.bookPublisher) fieldErrors({ publisher: ['common.errValidation'] });
      if (published && published.length > LIMITS.bookPublishedDate) fieldErrors({ published_date: ['common.errValidation'] });
      if (!existing.coverUrl && coverUrl) patch.coverUrl = coverUrl;
      if (!existing.publisher && publisher) patch.publisher = String(cleanPublisher(publisher)).slice(0, LIMITS.bookPublisher);
      if (!existing.publishedDate && published) patch.publishedDate = published.slice(0, LIMITS.bookPublishedDate);
      if (Object.keys(patch).length) {
        await db.update(books).set(patch).where(eq(books.id, existing.id));
        Object.assign(existing, patch);
      }
      return { book: existing, created: false };
    }
  }

  let title = str(body.title);
  let authors = str(body.authors);
  let source: InsertBook['source'] = 'manual';
  const record = await vettedCatalogueRecord(env, body.source, isbn13);
  if (record) {
    // The catalogue's title and authors, not the seller's.
    source = body.source as InsertBook['source'];
    title = record.title || title;
    authors = record.authors || authors || '';
  }

  // Book field validation.
  const errors: Record<string, string[]> = {};
  const publisher = str(body.publisher) ?? '';
  const publishedDate = str(body.published_date) ?? '';
  if (!title || !title.trim()) errors.title = ['common.errValidation'];
  else if (title.length > LIMITS.bookTitle) errors.title = ['common.errValidation'];
  if ((authors ?? '').length > LIMITS.bookAuthors) errors.authors = ['common.errValidation'];
  if (publisher.length > LIMITS.bookPublisher) errors.publisher = ['common.errValidation'];
  if (publishedDate.length > LIMITS.bookPublishedDate) errors.published_date = ['common.errValidation'];
  if (Object.keys(errors).length) fieldErrors(errors);

  const row: InsertBook = {
    id: crypto.randomUUID(),
    regionCode,
    isbn13,
    title: title!.trim(),
    authors: (authors ?? '').trim(),
    publisher: String(cleanPublisher(publisher)),
    publishedDate,
    coverUrl: coverUrl ?? '',
    source,
    createdAt: nowIso(),
    reviewedAt: null,
    reviewedById: null,
  };
  try {
    await db.insert(books).values(row);
  } catch (e) {
    // Lost a race with another create of the same ISBN.
    if (isbn13 && /UNIQUE/i.test(String(e))) apiError(400, 'listing.errIsbnTaken');
    throw e;
  }
  return { book: row as Book, created: true };
}
