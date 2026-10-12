#!/usr/bin/env node
/**
 * One-off import of the old Django/Postgres data into the Cloudflare D1 schema.
 *
 *   node --experimental-strip-types scripts/import-django.ts dump.json > import.sql
 *   (or: npx tsx scripts/import-django.ts dump.json > import.sql)
 *
 * Input:  `python manage.py dumpdata core.Currency core.Language core.Region
 *          core.City accounts.School core.Category accounts.User
 *          accounts.RegionVerification catalog.Book listings.Listing
 *          --indent 0 > dump.json`
 * Output: plain SQL on stdout (no BEGIN/COMMIT: D1 rejects them), one
 *         statement per line, ordered by foreign keys. Summary on stderr.
 *
 * Kept: reference data, user accounts (no passwords, no Google link), school
 * verifications, books and listings. Everything else is intentionally dropped.
 *
 * Re-running is safe: reference data is upserted by natural key; users, books,
 * listings and verifications use INSERT OR IGNORE, so rows that already exist
 * (and anything users changed on the new site since) are left alone.
 *
 * Foreign keys to schools / cities / categories / users / books are written as
 * natural-key sub-selects (region+code, region+slug, email, region+isbn13)
 * rather than the old integer ids, because src/db/seed.sql may already have
 * created those rows with different autoincrement ids.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Fixed namespace for the deterministic UUIDv5 ids. Never change it. */
export const NAMESPACE = '6f1d1c1e-7b0a-4f5e-9c3a-5b1d2e8a4c10';

type Json = unknown;
type Fields = Record<string, any>;
export interface DumpRow {
  model: string;
  pk: string | number;
  fields: Fields;
}

export interface ImportResult {
  sql: string;
  stats: Record<string, { in: number; out: number; skipped: Record<string, number> }>;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function uuidv5(name: string, namespace: string = NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const userUuid = (pk: string | number) => uuidv5(`django:accounts.user:${pk}`);
export const bookUuid = (pk: string | number) => uuidv5(`django:catalog.book:${pk}`);

/** SQL literal. Newlines become char(10) so every statement stays on one line. */
export function lit(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  const s = v.replace(/\0/g, '').replace(/'/g, "''");
  const parts = s.split(/(\r\n|\n|\r)/);
  if (parts.length === 1) return `'${s}'`;
  return parts
    .filter((p) => p !== '')
    .map((p) => (p === '\n' ? 'char(10)' : p === '\r' ? 'char(13)' : p === '\r\n' ? 'char(13) || char(10)' : `'${p}'`))
    .join(' || ');
}

const bool = (v: unknown): number => (v ? 1 : 0);

/** Django ISO timestamp -> `YYYY-MM-DDTHH:mm:ss.sssZ`, or null. */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** JSON column: dumpdata emits real JSON values, older versions a string. */
function jsonText(v: Json, fallback: string): string {
  if (v === null || v === undefined || v === '') return fallback;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Mirrors server/src/services/accounts/users.ts displayName. */
export function displayName(first: string | null | undefined, last: string | null | undefined): string {
  const l = last || '';
  const f = first || '';
  if (l && f) {
    if (/[A-Za-z]/.test(l) || /[A-Za-z]/.test(f)) return `${f} ${l}`;
    return `${l}${f}`;
  }
  return `${l}${f}`.trim();
}

function upsert(table: string, cols: string[], vals: string[], conflict: string[], update: string[]): string {
  const sets = update.map((c) => `${c} = excluded.${c}`).join(', ');
  return (
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')}) ` + `ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${sets};`
  );
}

function insertIgnore(table: string, cols: string[], vals: string[]): string {
  return `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

export function convert(rows: DumpRow[], now: string = new Date().toISOString()): ImportResult {
  const by = (m: string) =>
    rows.filter((r) => r.model === m).sort((a, b) => Number(a.pk) - Number(b.pk) || String(a.pk).localeCompare(String(b.pk)));

  const stats: ImportResult['stats'] = {};
  const stat = (name: string, n: number) => (stats[name] = { in: n, out: 0, skipped: {} });
  const skip = (name: string, reason: string) => {
    stats[name].skipped[reason] = (stats[name].skipped[reason] || 0) + 1;
  };
  const out: string[] = [];
  const emit = (name: string, sql: string) => {
    out.push(sql);
    stats[name].out++;
  };

  out.push('-- Generated by scripts/import-django.ts. Re-runnable; see docs/migrate-from-django.md.');

  // ---- currencies / languages ------------------------------------------------
  const currencies = new Set<string>();
  const currencyRows = by('core.currency');
  stat('currencies', currencyRows.length);
  for (const r of currencyRows) {
    const f = r.fields;
    currencies.add(String(r.pk));
    emit(
      'currencies',
      upsert(
        'currencies',
        ['code', 'symbol', 'decimal_places', 'symbol_position', 'is_active'],
        [
          lit(String(r.pk)),
          lit(f.symbol ?? ''),
          lit(f.decimal_places ?? 2),
          lit(f.symbol_position || 'prefix'),
          lit(bool(f.is_active ?? true)),
        ],
        ['code'],
        ['symbol', 'decimal_places', 'symbol_position', 'is_active'],
      ),
    );
  }

  const languages = new Set<string>();
  const languageRows = by('core.language');
  stat('languages', languageRows.length);
  for (const r of languageRows) {
    const f = r.fields;
    languages.add(String(r.pk));
    emit(
      'languages',
      upsert(
        'languages',
        ['code', 'name', 'native_name', 'is_active', 'sort_order'],
        [lit(String(r.pk)), lit(f.name ?? ''), lit(f.native_name ?? ''), lit(bool(f.is_active ?? true)), lit(f.sort_order ?? 0)],
        ['code'],
        ['name', 'native_name', 'is_active', 'sort_order'],
      ),
    );
  }

  // ---- regions ---------------------------------------------------------------
  const regions = new Set<string>();
  const regionRows = by('core.region');
  stat('regions', regionRows.length);
  for (const r of regionRows) {
    const f = r.fields;
    const code = String(r.pk);
    if (!currencies.has(String(f.currency)) || !languages.has(String(f.default_language))) {
      skip('regions', 'missing currency/default language');
      continue;
    }
    regions.add(code);
    // Region.languages M2M (list of language pks) -> JSON text array.
    const langs = JSON.stringify(((f.languages as string[]) || []).map(String));
    emit(
      'regions',
      upsert(
        'regions',
        [
          'code',
          'name',
          'default_currency',
          'default_language',
          'timezone',
          'translations',
          'languages',
          'search_engines',
          'edu_email_suffix',
          'sort_order',
          'is_active',
          'created_at',
        ],
        [
          lit(code),
          lit(f.name ?? code),
          lit(String(f.currency)),
          lit(String(f.default_language)),
          lit(f.timezone || 'Asia/Taipei'),
          lit(jsonText(f.translations, '{}')),
          lit(langs),
          lit(jsonText(f.search_engines, '[]')),
          lit(jsonText(f.edu_email_suffix, '[]')),
          lit(f.sort_order ?? 0),
          lit(bool(f.is_active ?? true)),
          lit(now),
        ],
        ['code'],
        [
          'name',
          'default_currency',
          'default_language',
          'timezone',
          'translations',
          'languages',
          'search_engines',
          'edu_email_suffix',
          'sort_order',
          'is_active',
        ],
      ),
    );
  }

  // ---- cities ----------------------------------------------------------------
  const cityKey = new Map<string, { region: string; code: string }>();
  const cityRows = by('core.city');
  stat('cities', cityRows.length);
  for (const r of cityRows) {
    const f = r.fields;
    if (!regions.has(String(f.region))) {
      skip('cities', 'missing region');
      continue;
    }
    cityKey.set(String(r.pk), { region: String(f.region), code: String(f.code) });
    emit(
      'cities',
      upsert(
        'cities',
        ['region_code', 'code', 'name', 'translations', 'sort_order'],
        [lit(String(f.region)), lit(String(f.code)), lit(f.name ?? ''), lit(jsonText(f.translations, '{}')), lit(f.sort_order ?? 0)],
        ['region_code', 'code'],
        ['name', 'translations', 'sort_order'],
      ),
    );
  }

  // ---- schools ---------------------------------------------------------------
  const schoolKey = new Map<string, { region: string; code: string }>();
  const schoolRows = by('accounts.school');
  stat('schools', schoolRows.length);
  for (const r of schoolRows) {
    const f = r.fields;
    if (!regions.has(String(f.region))) {
      skip('schools', 'missing region');
      continue;
    }
    if (!f.code) {
      skip('schools', 'blank code');
      continue;
    }
    schoolKey.set(String(r.pk), { region: String(f.region), code: String(f.code) });
    const c = f.city !== null && f.city !== undefined ? cityKey.get(String(f.city)) : undefined;
    const cityExpr = c ? `(SELECT id FROM cities WHERE region_code = ${lit(c.region)} AND code = ${lit(c.code)})` : 'NULL';
    emit(
      'schools',
      upsert(
        'schools',
        ['region_code', 'code', 'name', 'email_domain', 'translations', 'city_id', 'is_active', 'created_at'],
        [
          lit(String(f.region)),
          lit(String(f.code)),
          lit(f.name ?? ''),
          lit(String(f.email_domain ?? '').toLowerCase()),
          lit(jsonText(f.translations, '{}')),
          cityExpr,
          '1',
          lit(now),
        ],
        ['region_code', 'code'],
        ['name', 'email_domain', 'translations', 'city_id'],
      ),
    );
  }
  const schoolRef = (pk: unknown): string => {
    const s = pk !== null && pk !== undefined ? schoolKey.get(String(pk)) : undefined;
    return s ? `(SELECT id FROM schools WHERE region_code = ${lit(s.region)} AND code = ${lit(s.code)})` : 'NULL';
  };

  // ---- categories ------------------------------------------------------------
  const categoryKey = new Map<string, { region: string; slug: string }>();
  const categoryRows = by('core.category');
  stat('categories', categoryRows.length);
  for (const r of categoryRows) {
    const f = r.fields;
    if (!regions.has(String(f.region))) {
      skip('categories', 'missing region');
      continue;
    }
    categoryKey.set(String(r.pk), { region: String(f.region), slug: String(f.slug) });
    emit(
      'categories',
      upsert(
        'categories',
        ['region_code', 'slug', 'title', 'description', 'translations', 'sort_order', 'is_active'],
        [
          lit(String(f.region)),
          lit(String(f.slug)),
          lit(f.title ?? ''),
          lit(f.description ?? ''),
          lit(jsonText(f.translations, '{}')),
          lit(f.sort_order ?? 0),
          lit(bool(f.is_active ?? true)),
        ],
        ['slug', 'region_code'],
        ['title', 'description', 'translations', 'sort_order', 'is_active'],
      ),
    );
  }
  const categoryRef = (pk: unknown): string => {
    const c = pk !== null && pk !== undefined ? categoryKey.get(String(pk)) : undefined;
    return c ? `(SELECT id FROM categories WHERE region_code = ${lit(c.region)} AND slug = ${lit(c.slug)})` : 'NULL';
  };

  // ---- users -----------------------------------------------------------------
  // pk -> lowercase email, for every user that made it into the output.
  const userEmail = new Map<string, string>();
  const seenEmails = new Set<string>();
  const userRef = (pk: unknown): string | null => {
    const e = pk !== null && pk !== undefined ? userEmail.get(String(pk)) : undefined;
    return e ? `(SELECT id FROM users WHERE email = ${lit(e)})` : null;
  };
  const userRows = by('accounts.user');
  stat('users', userRows.length);
  for (const r of userRows) {
    const f = r.fields;
    const email = String(f.email || '')
      .trim()
      .toLowerCase();
    if (!email) {
      skip('users', 'empty email');
      continue;
    }
    if (seenEmails.has(email)) {
      skip('users', 'duplicate email (case-insensitive)');
      continue;
    }
    seenEmails.add(email);
    userEmail.set(String(r.pk), email);
    const first = f.first_name || '';
    const last = f.last_name || '';
    const created = iso(f.created_at) || now;
    const role = f.is_superuser ? 'admin' : f.is_staff ? 'staff' : 'user';
    emit(
      'users',
      insertIgnore(
        'users',
        [
          'id',
          'email',
          'name',
          'first_name',
          'last_name',
          'password_hash',
          'avatar_url',
          'show_avatar',
          'role',
          'google_id',
          'is_active',
          'is_banned',
          'last_login_at',
          'last_seen_bought_orders_at',
          'last_seen_sold_orders_at',
          'notify_new_message_email',
          'notify_push',
          'email_language',
          'site_language',
          'site_region',
          'deleted_at',
          'created_at',
          'updated_at',
        ],
        [
          lit(userUuid(r.pk)),
          lit(email),
          lit(displayName(first, last)),
          lit(first),
          lit(last),
          'NULL',
          lit(f.avatar_url || null),
          lit(bool(f.show_avatar ?? true)),
          lit(role),
          'NULL',
          lit(bool(f.is_active ?? true)),
          '0',
          lit(iso(f.last_login)),
          lit(iso(f.last_seen_bought_orders_at)),
          lit(iso(f.last_seen_sold_orders_at)),
          lit(bool(f.notify_new_message_email ?? true)),
          lit(bool(f.notify_push ?? true)),
          lit(f.email_language || 'auto'),
          lit(f.site_language || ''),
          lit(f.site_region || ''),
          lit(iso(f.deleted_at)),
          lit(created),
          lit(created),
        ],
      ),
    );
  }

  // ---- staff managed regions (User.managed_regions M2M) ---------------------
  stat('staff_managed_regions', 0);
  for (const r of userRows) {
    const email = userEmail.get(String(r.pk));
    if (!email) continue;
    for (const rc of (r.fields.managed_regions as string[]) || []) {
      stats.staff_managed_regions.in++;
      if (!regions.has(String(rc))) {
        skip('staff_managed_regions', 'missing region');
        continue;
      }
      emit(
        'staff_managed_regions',
        `INSERT OR IGNORE INTO staff_managed_regions (user_id, region_code) SELECT id, ${lit(String(rc))} FROM users WHERE email = ${lit(email)};`,
      );
    }
  }

  // ---- region verifications --------------------------------------------------
  const rvRows = by('accounts.regionverification');
  stat('region_verifications', rvRows.length);
  for (const r of rvRows) {
    const f = r.fields;
    const uref = userRef(f.user);
    if (!uref) {
      skip('region_verifications', 'missing user');
      continue;
    }
    if (!regions.has(String(f.region))) {
      skip('region_verifications', 'missing region');
      continue;
    }
    const created = iso(f.created_at);
    emit(
      'region_verifications',
      insertIgnore(
        'region_verifications',
        [
          'user_id',
          'region_code',
          'school_id',
          'edu_email',
          'is_manual_verification',
          'verified_at',
          'last_reverified_at',
          'expires_at',
          'is_active',
          'created_at',
        ],
        [
          uref,
          lit(String(f.region)),
          schoolRef(f.school),
          lit(f.edu_email ? String(f.edu_email).trim().toLowerCase() : null),
          lit(bool(f.is_manual_verification)),
          // D1 verified_at is NOT NULL; Django allowed NULL (never verified).
          lit(iso(f.verified_at) || created || now),
          lit(iso(f.last_reverified_at)),
          'NULL',
          lit(bool(f.is_active ?? true)),
          lit(created),
        ],
      ),
    );
  }

  // ---- books -----------------------------------------------------------------
  // pk -> SQL expression resolving to the book's id in D1.
  const bookRef = new Map<string, string>();
  const bookRows = by('catalog.book');
  stat('books', bookRows.length);
  for (const r of bookRows) {
    const f = r.fields;
    if (!regions.has(String(f.region))) {
      skip('books', 'missing region');
      continue;
    }
    const id = bookUuid(r.pk);
    const isbn = f.isbn13 ? String(f.isbn13) : null;
    // A book the new site already has for this (region, isbn13) keeps its own id.
    bookRef.set(
      String(r.pk),
      isbn ? `(SELECT id FROM books WHERE region_code = ${lit(String(f.region))} AND isbn13 = ${lit(isbn)})` : lit(id),
    );
    emit(
      'books',
      insertIgnore(
        'books',
        [
          'id',
          'region_code',
          'isbn13',
          'title',
          'authors',
          'publisher',
          'published_date',
          'cover_url',
          'source',
          'created_at',
          'reviewed_at',
          'reviewed_by_id',
        ],
        [
          lit(id),
          lit(String(f.region)),
          lit(isbn),
          lit(f.title ?? ''),
          lit(f.authors ?? ''),
          lit(f.publisher ?? ''),
          lit(f.published_date ?? ''),
          lit(f.cover_url ?? ''),
          lit(f.source || 'manual'),
          lit(iso(f.created_at) || now),
          lit(iso(f.reviewed_at)),
          userRef(f.reviewed_by) ?? 'NULL',
        ],
      ),
    );
  }

  // ---- listings --------------------------------------------------------------
  const listingRows = by('listings.listing');
  stat('listings', listingRows.length);
  for (const r of listingRows) {
    const f = r.fields;
    const seller = userRef(f.seller);
    if (!seller) {
      skip('listings', 'missing seller');
      continue;
    }
    const book = bookRef.get(String(f.book));
    if (!book) {
      skip('listings', 'missing book');
      continue;
    }
    if (!regions.has(String(f.region))) {
      skip('listings', 'missing region');
      continue;
    }
    if (!currencies.has(String(f.currency))) {
      skip('listings', 'missing currency');
      continue;
    }
    const created = iso(f.created_at) || now;
    emit(
      'listings',
      insertIgnore(
        'listings',
        [
          'id',
          'region_code',
          'currency_code',
          'book_id',
          'seller_id',
          'school_id',
          'price',
          'condition',
          'private_note',
          'description',
          'photos',
          'category_id',
          'status',
          'admin_locked',
          'admin_lock_reason',
          'locked_by_id',
          'locked_at',
          'course_name',
          'professor_name',
          'created_at',
          'updated_at',
        ],
        [
          lit(String(r.pk)),
          lit(String(f.region)),
          lit(String(f.currency)),
          book,
          seller,
          schoolRef(f.school),
          lit(Number(f.price)),
          lit(f.condition),
          lit(f.private_note ?? ''),
          lit(f.description ?? ''),
          lit(jsonText(f.photos, '[]')),
          categoryRef(f.category),
          lit(f.status || 'active'),
          lit(bool(f.admin_locked)),
          lit(f.admin_lock_reason ?? ''),
          userRef(f.locked_by) ?? 'NULL',
          lit(iso(f.locked_at)),
          lit(f.course_name ?? ''),
          lit(f.professor_name ?? ''),
          lit(created),
          lit(iso(f.updated_at) || created),
        ],
      ),
    );
  }

  return { sql: out.join('\n') + '\n', stats };
}

export function formatSummary(stats: ImportResult['stats']): string {
  const lines = ['import-django summary (in -> out, skipped):'];
  for (const [name, s] of Object.entries(stats)) {
    const skipped = Object.entries(s.skipped)
      .map(([k, n]) => `${n} ${k}`)
      .join('; ');
    lines.push(
      `  ${name.padEnd(22)} ${String(s.in).padStart(6)} -> ${String(s.out).padStart(6)}${skipped ? `   skipped: ${skipped}` : ''}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: import-django.ts <dumpdata.json> > import.sql\n');
    process.exit(2);
  }
  const rows = JSON.parse(readFileSync(file, 'utf8')) as DumpRow[];
  if (!Array.isArray(rows)) throw new Error('dump is not a JSON array (use dumpdata --format json)');
  const { sql, stats } = convert(rows);
  process.stdout.write(sql);
  process.stderr.write(formatSummary(stats) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
