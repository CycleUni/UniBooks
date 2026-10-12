/**
 * Listing and book output, built for a whole page of
 * rows with a fixed number of queries (with_seller_stats): sellers, schools,
 * categories and the sellers' reputation are each read once per page.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { inList } from '../../lib/sql';
import type { Env } from '../../env';
import { createDb, users, schools, orders, reviews, books, type Book, type Listing } from '../../db';
import { cleanPublisher } from '../catalog/common';
import { categorySlugsById, localizedSchoolName } from './places';

type Row = Record<string, unknown>;

export function parsePhotos(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** "First Last" with Latin letters, else LastFirst. */
export function displayName(user: Row | undefined): string {
  if (!user) return '';
  const first = typeof user.firstName === 'string' ? user.firstName : null;
  const last = typeof user.lastName === 'string' ? user.lastName : null;
  if (first !== null || last !== null) {
    const f = first ?? '';
    const l = last ?? '';
    if (f && l) return /[A-Za-z]/.test(l) || /[A-Za-z]/.test(f) ? `${f} ${l}` : `${l}${f}`;
    return `${l}${f}`.trim();
  }
  return typeof user.name === 'string' ? user.name : '';
}

/** The avatar URL, '' when the owner hid it. */
export function publicAvatarUrl(user: Row | undefined): string {
  if (!user) return '';
  if (user.showAvatar !== undefined && !user.showAvatar) return '';
  return typeof user.avatarUrl === 'string' ? user.avatarUrl : '';
}

export function serializeBook(book: Book): Record<string, unknown> {
  return {
    id: book.id,
    isbn13: book.isbn13,
    title: book.title,
    authors: book.authors,
    publisher: cleanPublisher(book.publisher),
    published_date: book.publishedDate,
    cover_url: book.coverUrl,
    source: book.source,
    created_at: book.createdAt,
    region: book.regionCode,
  };
}

export interface SellerStats {
  reviewCount: number;
  averageRating: number | null;
  completedSales: number;
}

/** Review count / average (no-show reports excluded) and completed sales, per seller. */
export async function sellerStats(env: Env, sellerIds: string[]): Promise<Map<string, SellerStats>> {
  const out = new Map<string, SellerStats>();
  const ids = [...new Set(sellerIds)];
  for (const id of ids) out.set(id, { reviewCount: 0, averageRating: null, completedSales: 0 });
  if (!ids.length) return out;
  const db = createDb(env.DB);
  const [reviewRows, salesRows] = await Promise.all([
    db
      .select({ id: reviews.revieweeId, n: sql<number>`count(*)`, avg: sql<number | null>`avg(${reviews.rating})` })
      .from(reviews)
      .where(and(inList(reviews.revieweeId, ids), eq(reviews.isNoShow, 0), isNotNull(reviews.rating)))
      .groupBy(reviews.revieweeId),
    db
      .select({ id: orders.sellerId, n: sql<number>`count(*)` })
      .from(orders)
      .where(and(inList(orders.sellerId, ids), eq(orders.status, 'completed')))
      .groupBy(orders.sellerId),
  ]);
  for (const r of reviewRows) {
    const s = out.get(r.id)!;
    s.reviewCount = Number(r.n);
    s.averageRating = s.reviewCount && r.avg !== null ? Math.round(Number(r.avg) * 10) / 10 : null;
  }
  for (const r of salesRows) out.get(r.id)!.completedSales = Number(r.n);
  return out;
}

export interface SerializeOptions {
  /** The signed-in viewer; the seller sees their own private_note unless stripped. */
  viewerId?: string | null;
  /** Bodies bound for a shared/public response never carry private_note. */
  stripPrivateNote?: boolean;
  lang?: string | null;
  /** Staff tools see moderation details (lock reason, who locked it). */
  staffView?: boolean;
}

/** Serialize listings (with their books). */
export async function serializeListings(
  env: Env,
  rows: Listing[],
  opts: SerializeOptions = {},
  bookById?: Map<string, Book>,
): Promise<Record<string, unknown>[]> {
  if (!rows.length) return [];
  const db = createDb(env.DB);
  const sellerIds = [...new Set(rows.map((r) => r.sellerId))];
  const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter((x): x is number => x !== null))];
  const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((x): x is number => x !== null))];
  const bookIds = [...new Set(rows.map((r) => r.bookId))].filter((id) => !bookById?.has(id));

  const [sellerRows, schoolRows, bookRows, slugs, stats] = await Promise.all([
    db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarUrl: users.avatarUrl,
        showAvatar: users.showAvatar,
      })
      .from(users)
      .where(inList(users.id, sellerIds)) as Promise<Row[]>,
    schoolIds.length ? (db.select().from(schools).where(inList(schools.id, schoolIds)) as Promise<Row[]>) : Promise.resolve([] as Row[]),
    bookIds.length ? db.select().from(books).where(inList(books.id, bookIds)) : Promise.resolve([] as Book[]),
    categorySlugsById(env, categoryIds),
    sellerStats(env, sellerIds),
  ]);
  const sellers = new Map(sellerRows.map((u) => [String(u.id), u]));
  const schoolMap = new Map(schoolRows.map((s) => [Number(s.id), s]));
  const bookMap = new Map<string, Book>(bookById ?? []);
  for (const b of bookRows) bookMap.set(b.id, b);

  return rows.map((l) => {
    const seller = sellers.get(l.sellerId);
    const book = bookMap.get(l.bookId);
    const school = l.schoolId !== null ? schoolMap.get(l.schoolId) : undefined;
    const st = stats.get(l.sellerId)!;
    const photos = parsePhotos(l.photos);
    const out: Record<string, unknown> = {
      id: l.id,
      seller_name: displayName(seller),
      seller_avatar_url: publicAvatarUrl(seller),
      school_name: school ? localizedSchoolName(school, opts.lang ?? null) : '',
      seller_school_id: l.schoolId,
      book_title: book?.title ?? '',
      book_authors: book?.authors ?? '',
      book_cover_url: book?.coverUrl ?? '',
      book_source: book?.source ?? '',
      course_name: l.courseName,
      professor_name: l.professorName,
      isbn: book ? book.isbn13 : '',
      category: l.categoryId !== null ? (slugs.get(l.categoryId) ?? null) : null,
      photo_url: photos[0] ?? '',
      seller_average_rating: st.reviewCount === 0 ? null : st.averageRating,
      seller_review_count: st.reviewCount,
      seller_completed_sales: st.completedSales,
      region: l.regionCode,
      currency: l.currencyCode,
      price: l.price,
      condition: l.condition,
      private_note: l.privateNote,
      description: l.description,
      photos,
      status: l.status,
      admin_locked: !!l.adminLocked,
      admin_lock_reason: l.adminLockReason,
      locked_at: l.lockedAt,
      created_at: l.createdAt,
      updated_at: l.updatedAt,
      book: l.bookId,
      seller: l.sellerId,
      school: l.schoolId,
      locked_by: l.lockedById,
    };
    const isSeller = !!opts.viewerId && opts.viewerId === l.sellerId;
    if (opts.stripPrivateNote || !isSeller) delete out.private_note;
    // Moderation internals: the seller may read why their listing was locked;
    // nobody but staff learns which staff member did it.
    if (!opts.staffView) {
      delete out.locked_by;
      if (!isSeller) delete out.admin_lock_reason;
    }
    return out;
  });
}
