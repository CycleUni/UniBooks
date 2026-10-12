import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

/**
 * The API's error contract, which the Angular app reads
 * (src/app/core/api-error.util.ts):
 *
 *   {"error": {"code": "<i18n key>"}}   a hand-written failure
 *   {"<field>": ["<i18n key>"]}         request validation (per-field error lists)
 *
 * The code is an i18n key the frontend translates; never English prose.
 */
export function apiError(status: ContentfulStatusCode, code: string, extra?: Record<string, unknown>): never {
  throw new HTTPException(status, {
    res: Response.json({ error: { code, ...extra } }, { status }),
    message: code,
  });
}

/** 400 with per-field errors: {"field": ["code"], ...}. */
export function fieldErrors(fields: Record<string, string[]>): never {
  throw new HTTPException(400, {
    res: Response.json(fields, { status: 400 }),
    message: 'validation',
  });
}

/**
 * Parse `data` with `schema`, or answer 400 with per-field errors.
 * Give schema issues i18n keys as their messages (e.g. `.min(1, 'sell.errPriceRequired')`);
 * an issue without one falls back to `fallbackCode`.
 */
export function validate<T extends z.ZodType>(schema: T, data: unknown, fallbackCode = 'common.errValidation'): z.output<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.map(String).join('.') : 'non_field_errors';
    const message = /^[a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+$/.test(issue.message) ? issue.message : fallbackCode;
    (fields[key] ??= []).push(message);
  }
  fieldErrors(fields);
}

/** Read a JSON body; an absent or malformed body is an empty object. */
export async function readJson(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/**
 * Page-number pagination: ?page=N (1-based) and, where the view allows it,
 * ?page_size=N capped at maxPageSize. Returns the slice bounds plus a
 * function that wraps the rows in {count, next, previous, results}.
 */
export function pagination(url: string, opts: { pageSize?: number; maxPageSize?: number; allowPageSize?: boolean } = {}) {
  const u = new URL(url);
  const defaultSize = opts.pageSize ?? 20;
  const requestedSize = Number.parseInt(u.searchParams.get('page_size') ?? '', 10);
  const pageSize =
    opts.allowPageSize && Number.isFinite(requestedSize) && requestedSize > 0
      ? Math.min(requestedSize, opts.maxPageSize ?? 100)
      : defaultSize;
  const rawPage = u.searchParams.get('page');
  const page = rawPage === null ? 1 : Number.parseInt(rawPage, 10);
  if (!Number.isFinite(page) || page < 1) {
    throw new HTTPException(404, {
      res: Response.json({ detail: 'Invalid page.' }, { status: 404 }),
      message: 'Invalid page.',
    });
  }

  const link = (n: number) => {
    const next = new URL(u);
    if (n === 1) next.searchParams.delete('page');
    else next.searchParams.set('page', String(n));
    return next.toString();
  };

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    limit: pageSize,
    wrap<T>(results: T[], count: number): Page<T> {
      return {
        count,
        next: page * pageSize < count ? link(page + 1) : null,
        previous: page > 1 ? link(page - 1) : null,
        results,
      };
    },
  };
}
