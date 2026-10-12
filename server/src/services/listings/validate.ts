/**
 * Field validation for listing create/PATCH.
 * Returns per-field errors ({field: [code]}) rather than throwing, so
 * the create view can wrap them in {"error":{"code":"sell.errValidation","fields":...}}
 * and the PATCH view can return them bare.
 */
import { eq } from 'drizzle-orm';
import type { Env } from '../../env';
import { createDb, books, type Book, type Listing } from '../../db';
import { resolveCategorySlug } from './places';

export const CONDITIONS = ['new', 'like_new', 'noted', 'damaged'] as const;
export type Condition = (typeof CONDITIONS)[number];
/** What a seller may set by hand; 'reserved' belongs to the order flow. */
export const SELLER_SETTABLE_STATUSES = ['active', 'sold', 'removed'] as const;
const MAX_PRICE = 2147483647;
const GENERIC = 'sell.errValidation';

export interface ListingValues {
  bookId?: string;
  book?: Book;
  price?: number;
  condition?: Condition;
  privateNote?: string;
  description?: string;
  categoryId?: number | null;
  status?: Listing['status'];
  courseName?: string;
  professorName?: string;
}

export type FieldErrors = Record<string, string[]>;

function has(body: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number(value);
  return null;
}

/** A string (numbers coerced), whitespace trimmed, null refused. */
function parseText(value: unknown, max?: number): string | null {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (max !== undefined && v.length > max) return null;
  return v;
}

export async function validateListingFields(
  env: Env,
  body: Record<string, unknown>,
  ctx: { regionCode: string; current?: Listing },
): Promise<{ values: ListingValues; errors: FieldErrors }> {
  const creating = !ctx.current;
  const errors: FieldErrors = {};
  const values: ListingValues = {};
  const fail = (field: string, code = GENERIC) => {
    (errors[field] ??= []).push(code);
  };

  // book
  if (has(body, 'book')) {
    const raw = body.book;
    if ((typeof raw !== 'string' && typeof raw !== 'number') || String(raw) === '') {
      fail('book');
    } else {
      const [book] = await createDb(env.DB)
        .select()
        .from(books)
        .where(eq(books.id, String(raw)))
        .limit(1);
      if (!book) fail('book');
      else if (book.regionCode !== ctx.regionCode) fail('book', 'listing.errBookRegionMismatch');
      else {
        values.bookId = book.id;
        values.book = book;
      }
    }
  } else if (creating) fail('book');

  // price
  if (has(body, 'price')) {
    const p = parseInteger(body.price);
    if (p === null || p < 0 || p > MAX_PRICE) fail('price');
    else values.price = p;
  } else if (creating) fail('price');

  // condition
  if (has(body, 'condition')) {
    if (typeof body.condition === 'string' && (CONDITIONS as readonly string[]).includes(body.condition)) {
      values.condition = body.condition as Condition;
    } else fail('condition');
  } else if (creating) fail('condition');

  for (const [field, key, max] of [
    ['private_note', 'privateNote', 2000],
    ['description', 'description', 5000],
    ['course_name', 'courseName', 255],
    ['professor_name', 'professorName', 255],
  ] as const) {
    if (!has(body, field)) continue;
    const v = parseText(body[field], max);
    if (v === null) fail(field);
    else values[key] = v;
  }

  // category (slug, resolved in the listing's own region)
  if (has(body, 'category')) {
    const slug = body.category;
    if (slug === null || slug === '') values.categoryId = null;
    else if (typeof slug !== 'string') fail('category');
    else {
      const cat = await resolveCategorySlug(env, ctx.regionCode, slug);
      if (!cat) fail('category');
      else values.categoryId = cat.id;
    }
  }

  // status
  if (has(body, 'status')) {
    const value = body.status;
    const current = ctx.current?.status;
    if (current === undefined) {
      if (value !== 'active') fail('status', 'listing.errStatusNotAllowed');
      else values.status = 'active';
    } else if (value === current) {
      values.status = current;
    } else if (current === 'reserved' || !(SELLER_SETTABLE_STATUSES as readonly unknown[]).includes(value)) {
      fail('status', 'listing.errStatusNotAllowed');
    } else {
      values.status = value as Listing['status'];
    }
  }

  return { values, errors };
}
