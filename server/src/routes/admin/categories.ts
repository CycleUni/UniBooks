import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, count, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { categories, createDb, type Category, type Database } from '../../db';
import { apiError, fieldErrors, pagination, readJson, validate } from '../../lib/http';
import { parseJsonObject } from '../../services/admin/i18n';
import { assertInScope, intId, notFound, regionExists, regionParam, scopeOf, scopeWhere } from '../../services/admin/scope';

/** Homepage college categories. */
export const categoryRoutes = new Hono<AppEnv>();

const INVALID = 'admin.errInvalidField';
const SLUG_RE = /^[-a-zA-Z0-9_]+$/;

export function categoryJson(cat: Category) {
  return {
    id: cat.id,
    slug: cat.slug,
    title: cat.title,
    description: cat.description,
    sort_order: cat.sortOrder,
    is_active: !!cat.isActive,
    translations: parseJsonObject(cat.translations),
    region: cat.regionCode,
  };
}

const categoryFields = {
  slug: z.string({ message: INVALID }).min(1, INVALID).max(50, INVALID).regex(SLUG_RE, INVALID),
  title: z.string({ message: INVALID }).min(1, INVALID).max(100, INVALID),
  description: z.string({ message: INVALID }).max(255, INVALID),
  sort_order: z.number({ message: INVALID }).int(INVALID).min(0, INVALID).max(2147483647, INVALID),
  is_active: z.boolean({ message: INVALID }),
  translations: z.record(z.string(), z.unknown(), { message: INVALID }),
  region: z.string({ message: INVALID }).min(1, INVALID),
};
const categoryCreate = z.object({
  ...categoryFields,
  description: categoryFields.description.optional(),
  sort_order: categoryFields.sort_order.optional(),
  is_active: categoryFields.is_active.optional(),
  translations: categoryFields.translations.optional(),
});
const categoryUpdate = z.object(categoryFields).partial();

async function slugTaken(db: Database, slug: string, region: string, excludeId?: number): Promise<boolean> {
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.slug, slug), eq(categories.regionCode, region)));
  return rows.some((r) => r.id !== excludeId);
}

categoryRoutes.get('/categories/', async (c) => {
  const db = createDb(c.env.DB);
  const page = pagination(c.req.url);
  const conds: (SQL | undefined)[] = [scopeWhere(categories.regionCode, await scopeOf(c))];
  const region = regionParam(c);
  if (region) conds.push(eq(categories.regionCode, region));
  const where = and(...conds);
  const [{ n }] = await db.select({ n: count() }).from(categories).where(where);
  const rows = await db
    .select()
    .from(categories)
    .where(where)
    .orderBy(asc(categories.sortOrder), asc(categories.id))
    .limit(page.limit)
    .offset(page.offset);
  return c.json(page.wrap(rows.map(categoryJson), n));
});

categoryRoutes.post('/categories/', async (c) => {
  const body = validate(categoryCreate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  if (!(await regionExists(db, body.region))) fieldErrors({ region: [INVALID] });
  if (await slugTaken(db, body.slug, body.region)) fieldErrors({ non_field_errors: [INVALID] });
  assertInScope(await scopeOf(c), body.region);
  const [row] = await db
    .insert(categories)
    .values({
      regionCode: body.region,
      slug: body.slug,
      title: body.title,
      description: body.description ?? '',
      translations: JSON.stringify(body.translations ?? {}),
      sortOrder: body.sort_order ?? 0,
      isActive: body.is_active === false ? 0 : 1,
    })
    .returning();
  return c.json(categoryJson(row), 201);
});

// ---------------------------------------------------------------------------
// Bulk import (before /categories/:id/)
// ---------------------------------------------------------------------------

categoryRoutes.post('/categories/bulk/', async (c) => {
  const data = await readJson(c.req);
  const action = data.action;
  const items = data.items ?? [];
  if (!Array.isArray(items)) apiError(400, INVALID);
  const currentRegion = regionParam(c);
  if (!currentRegion) apiError(400, 'admin.errMissingRegion');
  assertInScope(await scopeOf(c), currentRegion);

  const db = createDb(c.env.DB);
  const all = await db.select().from(categories);
  const existingHere = new Map(all.filter((x) => x.regionCode === currentRegion).map((x) => [x.slug, x]));
  const slugsElsewhere = new Set(all.filter((x) => x.regionCode !== currentRegion).map((x) => x.slug));

  const newItems: unknown[] = [];
  const modified: unknown[] = [];
  const unchanged: unknown[] = [];
  const forbidden: unknown[] = [];
  const writes: Parameters<Database['batch']>[0][number][] = [];
  let validCount = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const slug = item.slug;
    if (!slug) continue;
    validCount++;
    if (typeof slug !== 'string' || slug.length > 50 || !SLUG_RE.test(slug)) apiError(400, INVALID);
    const targetRegion = item.region ? String(item.region) : currentRegion;
    const existing = existingHere.get(slug);
    if (targetRegion !== currentRegion || (slugsElsewhere.has(slug) && !existing)) {
      forbidden.push(item);
      continue;
    }

    const str = (v: unknown, fallback: string, max: number) => {
      if (v === undefined) return fallback;
      if (typeof v !== 'string' || v.length > max) apiError(400, INVALID);
      return v;
    };
    const title = str(item.title, existing?.title ?? '', 100);
    const description = str(item.description, existing?.description ?? '', 255);
    let sortOrder = existing?.sortOrder ?? 0;
    if (item.sort_order !== undefined) {
      if (typeof item.sort_order !== 'number' || !Number.isInteger(item.sort_order) || item.sort_order < 0) apiError(400, INVALID);
      sortOrder = item.sort_order;
    }
    let isActive = existing ? !!existing.isActive : true;
    if (item.is_active !== undefined) {
      if (typeof item.is_active !== 'boolean') apiError(400, INVALID);
      isActive = item.is_active;
    }
    let translations: Record<string, unknown> = existing ? parseJsonObject(existing.translations) : {};
    if (item.translations !== undefined) {
      if (!item.translations || typeof item.translations !== 'object' || Array.isArray(item.translations)) apiError(400, INVALID);
      translations = item.translations as Record<string, unknown>;
    }

    if (!existing) {
      newItems.push(item);
      if (action === 'apply') {
        writes.push(
          db.insert(categories).values({
            regionCode: currentRegion,
            slug,
            title,
            description,
            sortOrder,
            isActive: isActive ? 1 : 0,
            translations: JSON.stringify(translations),
          }),
        );
      }
      continue;
    }
    const changed =
      existing.title !== title ||
      existing.description !== description ||
      existing.sortOrder !== sortOrder ||
      !!existing.isActive !== isActive ||
      stableJson(parseJsonObject(existing.translations)) !== stableJson(translations);
    if (!changed) {
      unchanged.push(item);
      continue;
    }
    modified.push({ old: categoryJson(existing), new: item });
    if (action === 'apply') {
      writes.push(
        db
          .update(categories)
          .set({ title, description, sortOrder, isActive: isActive ? 1 : 0, translations: JSON.stringify(translations) })
          .where(eq(categories.id, existing.id)),
      );
    }
  }

  if (validCount > 0 && forbidden.length === validCount) apiError(403, 'admin.errAllRegionsForbidden');
  if (writes.length) await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
  return c.json({ new: newItems, modified, unchanged, forbidden });
});

function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x as object)
          .sort()
          .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(sort(v));
}

// ---------------------------------------------------------------------------
// Detail (GET / PATCH / DELETE)
// ---------------------------------------------------------------------------

async function loadCategory(c: Context<AppEnv>): Promise<Category> {
  const id = intId(c.req.param('id'));
  const [row] = await createDb(c.env.DB)
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), scopeWhere(categories.regionCode, await scopeOf(c))))
    .limit(1);
  if (!row) notFound();
  return row;
}

categoryRoutes.get('/categories/:id/', async (c) => c.json(categoryJson(await loadCategory(c))));

categoryRoutes.patch('/categories/:id/', async (c) => {
  const instance = await loadCategory(c);
  const body = validate(categoryUpdate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  const region = body.region ?? instance.regionCode;
  if (body.region !== undefined && !(await regionExists(db, body.region))) fieldErrors({ region: [INVALID] });
  const slug = body.slug ?? instance.slug;
  if ((body.slug !== undefined || body.region !== undefined) && (await slugTaken(db, slug, region, instance.id))) {
    fieldErrors({ non_field_errors: [INVALID] });
  }
  assertInScope(await scopeOf(c), region);

  const set: Partial<Category> = {};
  if (body.slug !== undefined) set.slug = body.slug;
  if (body.title !== undefined) set.title = body.title;
  if (body.description !== undefined) set.description = body.description;
  if (body.sort_order !== undefined) set.sortOrder = body.sort_order;
  if (body.is_active !== undefined) set.isActive = body.is_active ? 1 : 0;
  if (body.translations !== undefined) set.translations = JSON.stringify(body.translations);
  if (body.region !== undefined) set.regionCode = body.region;
  let row = instance;
  if (Object.keys(set).length) {
    [row] = await db.update(categories).set(set).where(eq(categories.id, instance.id)).returning();
  }
  return c.json(categoryJson(row));
});

categoryRoutes.delete('/categories/:id/', async (c) => {
  const instance = await loadCategory(c);
  // listings.category_id is ON DELETE SET NULL.
  await createDb(c.env.DB).delete(categories).where(eq(categories.id, instance.id));
  return c.body(null, 204);
});
