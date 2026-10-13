/**
 * The dynamic half of the site's sitemap:
 *   /api/v1/sitemap.xml                                  sitemap index
 *   /api/v1/sitemap/<books|listings>-<region>-<page>.xml one page of URLs
 *
 * Pages are cut in id order (PAGE_SIZE URLs each) so a URL stays on its page
 * when its listing is edited; only what is for sale is listed.
 */
import { Hono, type Context } from 'hono';
import { cached } from '../lib/cache';
import { afterResponse } from '../lib/http';
import type { AppEnv, Env } from '../env';
import { activeRegions } from '../lib/region';

export const sitemapRoutes = new Hono<AppEnv>();

export const PAGE_SIZE = 5000;
const SITEMAP_TTL = 3600;
const XMLNS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const SECTION_RE = /^(books|listings)-([a-z]{2})-([1-9][0-9]*)\.xml$/;

type Kind = 'books' | 'listings';
interface Row {
  id: string;
  isbn13?: string | null;
  lastmod: string;
}

const KIND_SQL: Record<Kind, { cols: string; from: string }> = {
  // A book is dated by its newest active listing.
  books: {
    cols: 'b.id AS id, b.isbn13 AS isbn13, MAX(l.created_at) AS lastmod',
    from: `FROM books b JOIN listings l ON l.book_id = b.id AND l.status = 'active'
            WHERE b.region_code = ?1 AND l.region_code = ?1 {range} GROUP BY b.id`,
  },
  listings: {
    cols: 'l.id AS id, l.created_at AS lastmod',
    from: `FROM listings l WHERE l.region_code = ?1 AND l.status = 'active' {range}`,
  },
};

const idCol = (kind: Kind) => (kind === 'books' ? 'b.id' : 'l.id');

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const day = (stamp: string) => stamp.slice(0, 10);

/** [first id, newest lastmod] for each page of one kind and region. */
/** Page boundaries, cached: computing them scans every active row of the region. */
async function buildPages(env: Env, kind: Kind, code: string): Promise<Array<[string, string]>> {
  return cached(env, 'sitemap', `pages:${kind}:${code}`, SITEMAP_TTL, () => computePages(env, kind, code));
}

async function computePages(env: Env, kind: Kind, region: string): Promise<Array<[string, string]>> {
  const q = KIND_SQL[kind];
  const { results } = await env.DB.prepare(
    `SELECT ${idCol(kind)} AS id, ${kind === 'books' ? 'MAX(l.created_at)' : 'l.created_at'} AS lastmod ${q.from.replace('{range}', '')} ORDER BY ${idCol(kind)}`,
  )
    .bind(region)
    .all<{ id: string; lastmod: string }>();
  const pages: Array<[string, string]> = [];
  results.forEach((row, i) => {
    if (i % PAGE_SIZE === 0) pages.push([row.id, row.lastmod]);
    else if (row.lastmod > pages[pages.length - 1][1]) pages[pages.length - 1][1] = row.lastmod;
  });
  return pages;
}

function frontendOrigin(c: Context<AppEnv>): string {
  return new URL(c.req.url).origin;
}

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${SITEMAP_TTL}`,
    },
  });
}

/**
 * Serve a sitemap response from the edge cache, building it on a miss.
 * Crawlers fetch these often and a page is a query of up to PAGE_SIZE rows;
 * the KV-cached page boundaries alone still left one D1 query per request.
 * Keyed by the full URL, so each hostname gets its own absolute links.
 */
async function edgeCached(c: Context<AppEnv>, build: () => Promise<Response>): Promise<Response> {
  const key = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = await build();
  if (res.ok) await afterResponse(c, caches.default.put(key, res.clone()));
  return res;
}

sitemapRoutes.get('/sitemap.xml', (c) => edgeCached(c, () => sitemapIndex(c)));

async function sitemapIndex(c: Context<AppEnv>): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const entries: string[] = [];
  const codes = [...(await activeRegions(c.env)).keys()];
  for (const code of codes) {
    const region = code.toLowerCase();
    for (const kind of ['books', 'listings'] as Kind[]) {
      const pages = await buildPages(c.env, kind, code);
      pages.forEach(([, lastmod], i) => {
        const loc = `${origin}/api/v1/sitemap/${kind}-${region}-${i + 1}.xml`;
        entries.push(`<sitemap><loc>${escapeXml(loc)}</loc><lastmod>${day(lastmod)}</lastmod></sitemap>\n`);
      });
    }
  }
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${XMLNS}">\n${entries.join('')}</sitemapindex>\n`);
}

sitemapRoutes.get('/sitemap/:file', (c) => edgeCached(c, () => sitemapSection(c)));

async function sitemapSection(c: Context<AppEnv>): Promise<Response> {
  const m = SECTION_RE.exec(c.req.param('file') ?? '');
  if (!m) return Response.json({ detail: 'Not found.' }, { status: 404 });
  const kind = m[1] as Kind;
  const region = m[2];
  const page = Number(m[3]);
  const code = region.toUpperCase();
  if (!(await activeRegions(c.env)).has(code)) return Response.json({ detail: 'Not found.' }, { status: 404 });
  const pages = await buildPages(c.env, kind, code);
  if (page < 1 || page > pages.length) return Response.json({ detail: 'Not found.' }, { status: 404 });
  const start = page > 1 ? pages[page - 1][0] : null;
  const end = page < pages.length ? pages[page][0] : null;

  const range: string[] = [];
  const args: unknown[] = [code];
  if (start !== null) {
    args.push(start);
    range.push(`AND ${idCol(kind)} >= ?${args.length}`);
  }
  if (end !== null) {
    args.push(end);
    range.push(`AND ${idCol(kind)} < ?${args.length}`);
  }
  const q = KIND_SQL[kind];
  const { results } = await c.env.DB.prepare(`SELECT ${q.cols} ${q.from.replace('{range}', range.join(' '))} ORDER BY ${idCol(kind)}`)
    .bind(...args)
    .all<Row>();
  const origin = frontendOrigin(c);
  const loc = (row: Row) =>
    kind === 'books'
      ? `${origin}/${region}/book?${new URLSearchParams(row.isbn13 ? { isbn: row.isbn13 } : { id: row.id }).toString()}`
      : `${origin}/${region}/listing/${row.id}`;
  const entries = results.map((row) => `<url><loc>${escapeXml(loc(row))}</loc><lastmod>${day(row.lastmod)}</lastmod></url>\n`);
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${XMLNS}">\n${entries.join('')}</urlset>\n`);
}
