import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, count, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { invalidates } from '../../lib/cache';
import { categories, createDb, type Category, type Database } from '../../db';
import { apiError, fieldErrors, issueFields, pagination, readJson, validate } from '../../lib/http';
import { parseJsonObject } from '../../lib/json';
import { auditInsert, changedFields, writeAudit } from '../../services/admin/audit';
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

/** Most items one bulk import may carry. */
const BULK_MAX_ITEMS = 500;
/** A bulk item is a single-create body whose region (uppercased, as `?region=` is) may be left out. */
const categoryBulkItem = categoryCreate.extend({
  region: categoryFields.region.transform((v) => v.trim().toUpperCase()).optional(),
});

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

categoryRoutes.post('/categories/', invalidates('ref', 'search'), async (c) => {
  const body = validate(categoryCreate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  // Scope first, so the region and slug checks tell staff nothing about regions they do not manage.
  assertInScope(await scopeOf(c), body.region);
  if (!(await regionExists(db, body.region))) fieldErrors({ region: [INVALID] });
  if (await slugTaken(db, body.slug, body.region)) fieldErrors({ non_field_errors: [INVALID] });
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
  await writeAudit(
    db,
    {
      actorId: c.get('user')!.id,
      kind: 'admin.category_created',
      meta: { category_id: row.id, region: row.regionCode, slug: row.slug, title: row.title },
      targetType: 'category',
      targetId: row.id,
    },
    c,
  );
  return c.json(categoryJson(row), 201);
});

// ---------------------------------------------------------------------------
// Bulk import (before /categories/:id/)
// ---------------------------------------------------------------------------

categoryRoutes.post('/categories/bulk/', invalidates('ref', 'search'), async (c) => {
  const body = await readJson(c.req);
  const action = body.action;
  const items = body.items ?? [];
  if (!Array.isArray(items)) apiError(400, INVALID);
  if (items.length > BULK_MAX_ITEMS) apiError(400, 'admin.errTooManyItems', { max: BULK_MAX_ITEMS });
  const currentRegion = regionParam(c);
  if (!currentRegion) apiError(400, 'admin.errMissingRegion');
  assertInScope(await scopeOf(c), currentRegion);

  // Every item passes the single-create rules, and a slug may appear once per file.
  type Parsed = { index: number; item: Record<string, unknown>; data: z.output<typeof categoryBulkItem> };
  const parsed: Parsed[] = [];
  const itemErrors: { index: number; errors: Record<string, string[]> }[] = [];
  const seenSlugs = new Set<string>();
  for (const [index, raw] of items.entries()) {
    const result = categoryBulkItem.safeParse(raw);
    if (!result.success) {
      itemErrors.push({ index, errors: issueFields(result.error, INVALID) });
      continue;
    }
    if (seenSlugs.has(result.data.slug)) {
      itemErrors.push({ index, errors: { slug: [INVALID] } });
      continue;
    }
    seenSlugs.add(result.data.slug);
    parsed.push({ index, item: raw as Record<string, unknown>, data: result.data });
  }
  if (itemErrors.length) apiError(400, INVALID, { items: itemErrors });

  const db = createDb(c.env.DB);
  // Slugs are unique per region, as in single create: the same slug in another region is a different category.
  const existingHere = new Map(
    (await db.select().from(categories).where(eq(categories.regionCode, currentRegion))).map((x) => [x.slug, x]),
  );

  const newItems: unknown[] = [];
  const modified: unknown[] = [];
  const unchanged: unknown[] = [];
  const forbidden: { index: number }[] = [];
  const writes: Parameters<Database['batch']>[0][number][] = [];
  const created: string[] = [];
  const modifiedChanges: { category_id: number; slug: string; changes: Record<string, { before: unknown; after: unknown }> }[] = [];

  for (const { index, item, data } of parsed) {
    const slug = data.slug;
    if ((data.region ?? currentRegion) !== currentRegion) {
      forbidden.push({ index });
      continue;
    }
    const existing = existingHere.get(slug);
    const title = data.title;
    const description = data.description ?? existing?.description ?? '';
    const sortOrder = data.sort_order ?? existing?.sortOrder ?? 0;
    const isActive = data.is_active ?? (existing ? !!existing.isActive : true);
    const translations: Record<string, unknown> = data.translations ?? (existing ? parseJsonObject(existing.translations) : {});

    if (!existing) {
      newItems.push(item);
      if (action === 'apply') {
        created.push(slug);
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
      const set = { title, description, sortOrder, isActive: isActive ? 1 : 0, translations: JSON.stringify(translations) };
      modifiedChanges.push({ category_id: existing.id, slug, changes: changedFields(existing, set) });
      writes.push(db.update(categories).set(set).where(eq(categories.id, existing.id)));
    }
  }

  if (parsed.length > 0 && forbidden.length === parsed.length) apiError(403, 'admin.errAllRegionsForbidden');
  if (writes.length) {
    // One audit row summarises the import, in the same batch as the writes.
    writes.push(
      auditInsert(
        db,
        {
          actorId: c.get('user')!.id,
          kind: 'admin.categories_bulk_applied',
          meta: { region: currentRegion, created, modified: modifiedChanges },
          targetType: 'region',
          targetId: currentRegion,
        },
        c,
      ),
    );
    await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
  }
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

categoryRoutes.patch('/categories/:id/', invalidates('ref', 'search'), async (c) => {
  const instance = await loadCategory(c);
  const body = validate(categoryUpdate, await readJson(c.req), INVALID);
  const db = createDb(c.env.DB);
  const region = body.region ?? instance.regionCode;
  assertInScope(await scopeOf(c), region);
  if (body.region !== undefined && !(await regionExists(db, body.region))) fieldErrors({ region: [INVALID] });
  const slug = body.slug ?? instance.slug;
  if ((body.slug !== undefined || body.region !== undefined) && (await slugTaken(db, slug, region, instance.id))) {
    fieldErrors({ non_field_errors: [INVALID] });
  }

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
    const [updated] = await db.batch([
      db.update(categories).set(set).where(eq(categories.id, instance.id)).returning(),
      auditInsert(
        db,
        {
          actorId: c.get('user')!.id,
          kind: 'admin.category_updated',
          meta: { category_id: instance.id, changes: changedFields(instance, set) },
          targetType: 'category',
          targetId: instance.id,
        },
        c,
      ),
    ]);
    row = updated[0];
  }
  return c.json(categoryJson(row));
});

categoryRoutes.delete('/categories/:id/', invalidates('ref', 'search'), async (c) => {
  const instance = await loadCategory(c);
  // listings.category_id is ON DELETE SET NULL.
  const db = createDb(c.env.DB);
  await db.batch([
    db.delete(categories).where(eq(categories.id, instance.id)),
    auditInsert(
      db,
      {
        actorId: c.get('user')!.id,
        kind: 'admin.category_deleted',
        meta: { category_id: instance.id, region: instance.regionCode, slug: instance.slug, title: instance.title },
        targetType: 'category',
        targetId: instance.id,
      },
      c,
    ),
  ]);
  return c.body(null, 204);
});
