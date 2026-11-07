/**
 * The keyword search's full-text index (migration 0001_search_fts, services/search/text-match.ts):
 * what it matches, that its triggers keep it in step with books / listings,
 * and that a text too short for it still matches by scanning.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppEnv } from '../../src/env';
import { errorHandler } from '../../src/middleware/error';
import { searchRoutes } from '../../src/routes/search';
import { INDEX_MIN_CHARS, ftsPhrase, textMatch } from '../../src/services/search/text-match';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/api/v1/search', searchRoutes);

const NOW = '2026-01-01T00:00:00.000Z';
const SELLER = 'aaaaaaaa-1111-4111-8111-111111111111';
const CALC = 'bbbbbbbb-1111-4111-8111-111111111111';
const PHYS = 'bbbbbbbb-2222-4222-8222-222222222222';
const QUOTE = 'bbbbbbbb-3333-4333-8333-333333333333';
const L_CALC = 'cccccccc-1111-4111-8111-111111111111';
const L_PHYS = 'cccccccc-2222-4222-8222-222222222222';

const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args);

async function ids(q: string, extra = ''): Promise<string[]> {
  const res = await app.fetch(
    new Request(`http://x/api/v1/search/books?q=${encodeURIComponent(q)}${extra}`, { headers: { 'X-Region': 'TW' } }),
    env,
  );
  expect(res.status, q).toBe(200);
  const body = (await res.json()) as { results: Array<{ id: string }> };
  return body.results.map((r) => r.id).filter(Boolean);
}

async function integrityOk() {
  // FTS5 raises an error from these commands when the index disagrees with its content table.
  await env.DB.batch([
    run(`INSERT INTO books_fts(books_fts, rank) VALUES ('integrity-check', 1)`),
    run(`INSERT INTO listings_fts(listings_fts, rank) VALUES ('integrity-check', 1)`),
  ]);
}

describe('search full-text index', () => {
  beforeAll(async () => {
    await env.DB.batch([
      run(`INSERT OR IGNORE INTO currencies (code, symbol) VALUES ('TWD', 'NT$')`),
      run(`INSERT OR IGNORE INTO languages (code, name) VALUES ('zh-TW', 'Chinese')`),
      run(
        `INSERT OR IGNORE INTO regions (code, name, default_currency, default_language, timezone, search_engines, created_at)
         VALUES ('TW', 'Taiwan', 'TWD', 'zh-TW', 'Asia/Taipei', '["googlebooks"]', ?)`,
        NOW,
      ),
      run(
        `INSERT INTO schools (id, region_code, code, name, email_domain, created_at) VALUES (1, 'TW', 'NTU', 'NTU', 'ntu.edu.tw', ?)`,
        NOW,
      ),
      run(
        `INSERT INTO schools (id, region_code, code, name, email_domain, created_at) VALUES (2, 'TW', 'NCCU', 'NCCU', 'nccu.edu.tw', ?)`,
        NOW,
      ),
      run(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, 'fts@ntu.edu.tw', ?, ?)`, SELLER, NOW, NOW),
      run(
        `INSERT INTO books (id, region_code, isbn13, title, authors, source, created_at)
         VALUES (?, 'TW', '9789861234567', '微積分 Calculus 第九版', 'James Stewart', 'manual', ?)`,
        CALC,
        NOW,
      ),
      run(
        `INSERT INTO books (id, region_code, isbn13, title, authors, source, created_at)
         VALUES (?, 'TW', '9789867654321', '普通物理學', '陳志明', 'manual', ?)`,
        PHYS,
        NOW,
      ),
      run(
        `INSERT INTO books (id, region_code, title, source, created_at) VALUES (?, 'TW', 'The "Quoted" OR NEAR(book)*', 'manual', ?)`,
        QUOTE,
        NOW,
      ),
      run(
        `INSERT INTO listings (id, region_code, currency_code, book_id, seller_id, school_id, price, condition,
                               course_name, professor_name, created_at, updated_at)
         VALUES (?, 'TW', 'TWD', ?, ?, 1, 300, 'noted', '工程數學一', '林教授', ?, ?)`,
        L_CALC,
        CALC,
        SELLER,
        NOW,
        NOW,
      ),
      run(
        `INSERT INTO listings (id, region_code, currency_code, book_id, seller_id, school_id, price, condition,
                               course_name, professor_name, created_at, updated_at)
         VALUES (?, 'TW', 'TWD', ?, ?, 2, 200, 'new', '普通物理實驗', '黃教授', ?, ?)`,
        L_PHYS,
        PHYS,
        SELLER,
        NOW,
        NOW,
      ),
    ]);
  });

  // The catalogues answer nothing: every result is a local book.
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ totalItems: 0, items: [], docs: [] }));
  });

  it('uses the index from INDEX_MIN_CHARS characters, counted as characters, not bytes', () => {
    expect(INDEX_MIN_CHARS).toBe(3);
    expect(textMatch('微積').indexed).toBe(false);
    expect(textMatch('微積分').indexed).toBe(true);
    expect(textMatch('ab').indexed).toBe(false);
    expect(textMatch('abc').indexed).toBe(true);
    expect(ftsPhrase('a "b" c')).toBe('"a ""b"" c"');
  });

  it('matches a substring of the title, authors or ISBN, CJK and Latin, any case', async () => {
    expect(await ids('積分 Calc')).toEqual([CALC]);
    expect(await ids('CALCULUS')).toEqual([CALC]);
    expect(await ids('stewart')).toEqual([CALC]);
    expect(await ids('普通物理')).toEqual([PHYS]);
    expect(await ids('陳志明')).toEqual([PHYS]);
    expect(await ids('1234567')).toEqual([CALC]);
    expect(await ids('不存在的書')).toEqual([]);
  });

  it("matches an active listing's course or professor name, within the chosen school", async () => {
    expect(await ids('工程數學')).toEqual([CALC]);
    expect(await ids('林教授')).toEqual([CALC]);
    expect(await ids('工程數學', '&school=NTU')).toEqual([CALC]);
    expect(await ids('工程數學', '&school=NCCU')).toEqual([]);
  });

  it('reads search syntax in the text as plain characters', async () => {
    expect(await ids('"Quoted" OR')).toEqual([QUOTE]);
    expect(await ids('NEAR(book)*')).toEqual([QUOTE]);
    expect(await ids('" OR "')).toEqual([]);
  });

  it('still matches a text shorter than the index can answer, by scanning', async () => {
    expect(await ids('微積')).toEqual([CALC]);
    expect(await ids('物理')).toEqual([PHYS]);
    expect(await ids('林教')).toEqual([CALC]);
  });

  it('counts facets over the indexed match', async () => {
    const res = await app.fetch(
      new Request(`http://x/api/v1/search/books?q=${encodeURIComponent('工程數學')}`, { headers: { 'X-Region': 'TW' } }),
      env,
    );
    const body = (await res.json()) as {
      facets: { course: Array<{ value: string; count: number }>; condition: Array<{ value: string; count: number }> };
    };
    expect(body.facets.condition.find((f) => f.value === 'noted')?.count).toBe(1);
    expect(body.facets.condition.find((f) => f.value === 'new')?.count).toBe(0);
  });

  it('follows edits, status changes and deletes', async () => {
    await env.DB.batch([
      run(`UPDATE books SET title = '線性代數導論' WHERE id = ?`, PHYS),
      run(`UPDATE listings SET course_name = '應用數學' WHERE id = ?`, L_CALC),
    ]);
    // Only the old title had this; the listing's course 普通物理實驗 does not.
    expect(await ids('物理學')).toEqual([]);
    expect(await ids('線性代數')).toEqual([PHYS]);
    expect(await ids('工程數學')).toEqual([]);
    expect(await ids('應用數學')).toEqual([CALC]);
    await integrityOk();

    // A listing no longer for sale stops matching; its book's own text still does.
    await env.DB.batch([run(`UPDATE listings SET status = 'sold' WHERE id = ?`, L_CALC)]);
    expect(await ids('應用數學')).toEqual([]);
    expect(await ids('Calculus')).toEqual([CALC]);

    // Deleting a book takes its listings (ON DELETE CASCADE) out of the index too.
    await env.DB.batch([run(`DELETE FROM books WHERE id = ?`, PHYS)]);
    expect(await ids('線性代數')).toEqual([]);
    expect(await ids('普通物理實驗')).toEqual([]);
    const left = await env.DB.prepare(`SELECT count(*) AS n FROM listings_fts WHERE listings_fts MATCH ?`)
      .bind(ftsPhrase('普通物理實驗'))
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    await integrityOk();
  });

  it('rebuilds from the source tables to the same answers', async () => {
    const before = await ids('Calculus');
    await env.DB.batch([
      run(`INSERT INTO books_fts(books_fts) VALUES ('rebuild')`),
      run(`INSERT INTO listings_fts(listings_fts) VALUES ('rebuild')`),
    ]);
    expect(await ids('Calculus')).toEqual(before);
    await integrityOk();
  });
});
