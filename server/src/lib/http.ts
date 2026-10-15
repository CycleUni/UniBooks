import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

/**
 * The API's error contract, which the Angular app reads
 * (src/app/core/api-error.util.ts). Every failure has one shape:
 *
 *   {"error": {"code": "<i18n key>", ...extra}}
 *   {"error": {"code": "common.errValidation", "fields": {"<field>": ["<i18n key>"]}}}
 *
 * The code is an i18n key the frontend translates; never English prose.
 */
export function apiError(status: ContentfulStatusCode, code: string, extra?: Record<string, unknown>): never {
  throw new HTTPException(status, {
    res: Response.json({ error: { code, ...extra } }, { status }),
    message: code,
  });
}

export type FieldErrors = Record<string, string[]>;

/** 400 with per-field errors: {"error": {"code", "fields": {"field": ["code"]}}}. */
export function fieldErrors(fields: FieldErrors, code = 'common.errValidation'): never {
  apiError(400, code, { fields });
}

/**
 * Parse `data` with `schema`, or answer 400 with per-field errors.
 * Give schema issues i18n keys as their messages (e.g. `.min(1, 'sell.errPriceRequired')`);
 * an issue without one falls back to `fallbackCode`.
 */
export function validate<T extends z.ZodType>(schema: T, data: unknown, fallbackCode = 'common.errValidation'): z.output<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const { code, fields } = describeIssues(result.error, fallbackCode);
  fieldErrors(fields, code);
}

/**
 * Zod issues as {code, fields}: i18n-key messages pass through, anything else
 * becomes the fallback. An issue on the body as a whole (no path) is the code;
 * otherwise the code is the generic validation one.
 */
export function describeIssues(error: z.ZodError, fallbackCode = 'common.errValidation'): { code: string; fields: FieldErrors } {
  let code = 'common.errValidation';
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const message = /^[a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+$/.test(issue.message) ? issue.message : fallbackCode;
    if (issue.path.length) (fields[issue.path.map(String).join('.')] ??= []).push(message);
    else code = message;
  }
  return { code, fields };
}

/** Read a JSON body; an absent or malformed body is an empty object. */
export async function readJson(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export interface Page<T> {
  count: number;
  results: T[];
}

/**
 * Page-number pagination: ?page=N (1-based) and, where the route allows it,
 * ?page_size=N capped at maxPageSize. Returns the slice bounds plus a
 * function that wraps the rows in {count, results}. A page past the end is
 * simply empty; a page number that is not a positive integer is a 400.
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
  if (!Number.isFinite(page) || page < 1) fieldErrors({ page: ['common.errValidation'] });

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    limit: pageSize,
    wrap<T>(results: T[], count: number): Page<T> {
      return { count, results };
    },
  };
}

/** 404 for a missing object or route: {"error": {"code": "common.errNotFound"}}. */
export function notFound(c: Context): Response {
  return c.json({ error: { code: 'common.errNotFound' } }, 404);
}

/**
 * Run `work` after the response when the runtime allows it (waitUntil), or
 * before returning when there is no execution context (app.request in tests).
 */
export async function afterResponse(c: Context, work: Promise<unknown>): Promise<void> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(work);
  else await work;
}
