import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, createUser, login, seedReference } from '../accounts/helpers';
import { MAX_CLAIM_WINDOW_DAYS } from '../../src/services/drives/claims';

let n = 0;
async function account(role = 'user') {
  const email = `claim-${role}-${++n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const id = await createUser(email, { role });
  const { access } = await login(email);
  return { id, email, token: access };
}

/** A student verified in TW (school 1); with `studentNumber`, staff also approved that number at `school`. */
async function student(studentNumber = '', school = 1) {
  const s = await account();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO region_verifications (user_id, region_code, school_id, verified_at, is_active, created_at) VALUES (?, 'TW', 1, ?, 1, ?)`,
  )
    .bind(s.id, now, now)
    .run();
  if (studentNumber) {
    await env.DB.prepare(
      `INSERT INTO student_id_verifications (id, user_id, region_code, school_id, student_number, status, reviewed_at, created_at, updated_at)
       VALUES (?, ?, 'TW', ?, ?, 'approved', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), s.id, school, studentNumber, now, now, now)
      .run();
  }
  return s;
}

type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** Titles of their own for each drive: the database is shared across tests. */
const titles = (tag: string) => ({
  calculus: { title: `Calculus ${tag}`, authors: 'Stewart', source: 'manual' },
  physics: { title: `Physics ${tag}`, authors: 'Halliday', source: 'manual' },
  chemistry: { title: `Chemistry ${tag}`, authors: 'Zumdahl', source: 'manual' },
});

describe('registering for a book drive', () => {
  beforeEach(async () => {
    await seedReference();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO categories (id, region_code, slug, title, departments, sort_order, is_active)
       VALUES (902, 'TW', 'mgmt-c', 'Management', '[{"name":"資訊管理學系","aliases":["資管"]}]', 0, 1)`,
    ).run();
  });

  /** An organization (school 1) with an admin, a drive, and copies taken in: Calculus ×2, Physics ×1, Chemistry ×1. */
  async function setup() {
    const root = await account('admin');
    const org = await json(await call('/api/v1/admin/organizations', { token: root.token, body: { school: 1, name: `學生會-c${n}` } }));
    const lead = await account();
    await call(`/api/v1/admin/organizations/${org.id}/admins`, { token: root.token, body: { email: lead.email } });
    const drive = await json(await call('/api/v1/drives', { token: lead.token, body: { organization: org.id, title: '期初贈書' } }));
    const take = async (book: Json, extra: Json = {}) => {
      const res = await call(`/api/v1/drives/${drive.id}/copies`, {
        token: lead.token,
        body: { book, condition: 'like_new', donor_student_number: 'D000001', donor_department: '資管', ...extra },
      });
      expect(res.status).toBe(201);
      return json(res);
    };
    const tag = crypto.randomUUID().slice(0, 8);
    const t = titles(tag);
    const c1 = await take(t.calculus);
    await take({ ...t.calculus });
    const p1 = await take(t.physics);
    const ch = await take(t.chemistry);
    const books = { calculus: c1.book.id as string, physics: p1.book.id as string, chemistry: ch.book.id as string };
    return { root, org, lead, drive, books, tag, copies: { chemistry: ch.id as string } };
  }

  const open = (drive: Json, token: string, closes = inDays(7)) =>
    call(`/api/v1/drives/${drive.id}`, { token, method: 'PATCH', body: { status: 'claiming', claim_closes_at: closes } });
  const register = (drive: Json, token: string, bookId: string, extra: Json = {}) =>
    call(`/api/v1/drives/${drive.id}/claims`, { token, body: { book_id: bookId, department: '資管', grade: 2, ...extra } });

  it('opens registration only from collecting, with a close time ahead and within the limit, and stops intake', async () => {
    const { lead, drive, books } = await setup();
    const helper = await account();
    await call(`/api/v1/drives/${drive.id}/staff`, { token: lead.token, body: { email: helper.email } });

    expect((await open(drive, helper.token)).status).toBe(403);
    expect((await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { status: 'claiming' } })).status).toBe(
      400,
    );
    expect((await open(drive, lead.token, inDays(-1))).status).toBe(400);
    expect((await open(drive, lead.token, inDays(MAX_CLAIM_WINDOW_DAYS + 1))).status).toBe(400);
    // A close time only goes with registration.
    expect(
      (await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { claim_closes_at: inDays(3) } })).status,
    ).toBe(400);

    const opened = await json(await open(drive, lead.token));
    expect(opened.status).toBe('claiming');
    expect(opened.claim_opens_at).toBeTruthy();
    expect(Date.parse(opened.claim_closes_at)).toBeGreaterThan(Date.now());
    expect(opened.counts).toMatchObject({ claims: 0, claimants: 0 });

    // No more books come in while students register.
    const late = await call(`/api/v1/drives/${drive.id}/copies`, {
      token: lead.token,
      body: { book: titles('late').physics, condition: 'new' },
    });
    expect(late.status).toBe(400);

    // The close time moves while registration runs.
    const moved = await json(
      await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { claim_closes_at: inDays(10) } }),
    );
    expect(Date.parse(moved.claim_closes_at)).toBeGreaterThan(Date.now() + 9 * 86_400_000);

    // Back to collecting while nobody has registered; not once somebody has.
    const back = await json(await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { status: 'intake' } }));
    expect(back).toMatchObject({ status: 'intake', claim_opens_at: null, claim_closes_at: null });
    await open(drive, lead.token);
    const s = await student();
    expect((await register(drive, s.token, books.calculus)).status).toBe(201);
    const refused = await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { status: 'intake' } });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error.code).toBe('drive.errHasClaims');
  });

  it('needs a drive taking registrations and a book on its shelf, and opens it to anyone only then', async () => {
    const { lead, drive, books, copies, tag } = await setup();
    const s = await student();
    // Collecting: nobody outside sees the drive.
    expect((await call(`/api/v1/drives/${drive.id}/public`)).status).toBe(404);
    expect((await register(drive, s.token, books.calculus)).status).toBe(404);
    const ours = async () =>
      (await json(await call('/api/v1/drives/open', { headers: { 'X-Region': 'TW' } }))).results.filter((d: Json) => d.id === drive.id);
    expect(await ours()).toEqual([]);

    // Withdrawn before opening: Chemistry has no copy left.
    await call(`/api/v1/drives/${drive.id}/copies/${copies.chemistry}`, {
      token: lead.token,
      method: 'PATCH',
      body: { status: 'withdrawn' },
    });
    await open(drive, lead.token);

    const page = await json(await call(`/api/v1/drives/${drive.id}/public`));
    expect(page).toMatchObject({ title: '期初贈書', open: true, max_claims_per_user: 3, my_claims: 0 });
    expect(page.organization.display_name).toContain('國立臺灣大學');
    expect(page.titles.map((t: Json) => [t.book.title, t.remaining, t.claimants])).toEqual([
      [`Calculus ${tag}`, 2, 0],
      [`Physics ${tag}`, 1, 0],
    ]);
    // Counts only: nothing about who gave the books.
    expect(JSON.stringify(page)).not.toContain('D000001');

    expect(await ours()).toEqual([expect.objectContaining({ id: drive.id, titles: 2, copies: 3, open: true })]);

    // A school's home page: its organizations' drives, previewing the titles with most copies left.
    const home = async (school: string, titles = 0) =>
      (await json(await call(`/api/v1/drives/open?school=${school}&titles=${titles}`, { headers: { 'X-Region': 'TW' } }))).results.filter(
        (d: Json) => d.id === drive.id,
      );
    const [preview] = await home('NTU', 1);
    expect(preview.preview.map((t: Json) => [t.book.title, t.remaining, t.my_claim])).toEqual([[`Calculus ${tag}`, 2, null]]);
    expect((await home('NTU'))[0].preview).toBeUndefined();
    expect(await home('NOSUCH', 4)).toEqual([]);

    const none = await register(drive, s.token, books.chemistry);
    expect(none.status).toBe(400);
    expect((await json(none)).error.code).toBe('drive.errNoCopies');
  });

  it('takes registrations from students verified in the region, one per title, up to the limit, even when racing', async () => {
    const { lead, drive, books } = await setup();
    await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { max_claims_per_user: 2 } });
    await open(drive, lead.token);

    const unverified = await account();
    const blocked = await register(drive, unverified.token, books.calculus);
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).error.code).toBe('acct.errUnverifiedInRegion');
    expect((await call(`/api/v1/drives/${drive.id}/claims`, { body: { book_id: books.calculus } })).status).toBe(401);

    const s = await student();
    const first = await register(drive, s.token, books.calculus, { department: '資管系', grade: '大二' });
    expect(first.status).toBe(201);
    const claim = await json(first);
    expect(claim).toMatchObject({ status: 'registered', department: '資訊管理學系', grade: 2, student_number: '' });

    const again = await register(drive, s.token, books.calculus);
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe('drive.errAlreadyClaimed');
    expect((await register(drive, s.token, books.calculus, { grade: 9 })).status).toBe(400);

    // Two at once against a limit with one place left: only one lands.
    const racing = await Promise.all([register(drive, s.token, books.physics), register(drive, s.token, books.chemistry)]);
    expect(racing.map((r) => r.status).sort()).toEqual([201, 400]);
    const mine = await json(await call('/api/v1/drives/claims/mine', { token: s.token }));
    expect(mine.results).toHaveLength(2);
    const over = racing.find((r) => r.status === 400)!;
    expect((await json(over)).error).toMatchObject({ code: 'drive.errClaimLimit', max: 2 });

    // More people may register than there are copies.
    const others = await Promise.all([student(), student(), student()]);
    for (const o of others) expect((await register(drive, o.token, books.calculus)).status).toBe(201);
    const page = await json(await call(`/api/v1/drives/${drive.id}/public`, { token: s.token }));
    const calc = page.titles.find((t: Json) => t.book.id === books.calculus);
    expect(calc).toMatchObject({ remaining: 2, claimants: 4, my_claim: { id: claim.id, status: 'registered' } });
    expect(page.my_claims).toBe(2);
    const staffView = await json(await call(`/api/v1/drives/${drive.id}`, { token: lead.token }));
    expect(staffView.counts).toMatchObject({ claims: 5, claimants: 4 });
  });

  it('lets students change and cancel while registration runs, and register again on the same row', async () => {
    const { lead, drive, books } = await setup();
    await open(drive, lead.token);
    const s = await student();
    const claim = await json(await register(drive, s.token, books.calculus));

    const other = await student();
    expect((await call(`/api/v1/drives/${drive.id}/claims/${claim.id}`, { token: other.token, method: 'DELETE' })).status).toBe(404);

    const changed = await json(
      await call(`/api/v1/drives/${drive.id}/claims/${claim.id}`, { token: s.token, method: 'PATCH', body: { grade: 3 } }),
    );
    expect(changed).toMatchObject({ grade: 3, department: '資訊管理學系' });

    const cancelled = await json(await call(`/api/v1/drives/${drive.id}/claims/${claim.id}`, { token: s.token, method: 'DELETE' }));
    expect(cancelled.status).toBe('cancelled');
    expect((await json(await call('/api/v1/drives/claims/mine', { token: s.token }))).results).toEqual([]);
    expect((await call(`/api/v1/drives/${drive.id}/claims/${claim.id}`, { token: s.token, method: 'DELETE' })).status).toBe(400);

    const back = await json(await register(drive, s.token, books.calculus, { grade: 1 }));
    expect(back).toMatchObject({ id: claim.id, status: 'registered', grade: 1 });

    // After the close time nothing changes, and the drive says so.
    await env.DB.prepare(`UPDATE book_drives SET claim_closes_at = ? WHERE id = ?`).bind(inDays(-0.001), drive.id).run();
    const late = await call(`/api/v1/drives/${drive.id}/claims/${claim.id}`, { token: s.token, method: 'PATCH', body: { grade: 2 } });
    expect(late.status).toBe(400);
    expect((await json(late)).error.code).toBe('drive.errClaimsClosed');
    expect((await register(drive, s.token, books.physics)).status).toBe(400);
    expect((await json(await call(`/api/v1/drives/${drive.id}/public`))).open).toBe(false);

    // Ended by its organization: the registration stays, and says where its drive went.
    await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { status: 'closed' } });
    expect((await call(`/api/v1/drives/${drive.id}/public`)).status).toBe(404);
    const mine = await json(await call('/api/v1/drives/claims/mine', { token: s.token }));
    expect(mine.results).toEqual([
      expect.objectContaining({ id: claim.id, status: 'registered', drive: expect.objectContaining({ status: 'closed' }) }),
    ]);
  });

  it("fills the form from the student number staff approved at the organization's school and its roster", async () => {
    const { lead, org, drive, books } = await setup();
    await call(`/api/v1/orgs/${org.id}/members/import`, {
      token: lead.token,
      body: { mode: 'merge', commit: true, rows: [{ student_number: 'B10001', name: '甲', department: '資管', grade: 3 }] },
    });
    await open(drive, lead.token);

    const member = await student('B10001');
    const defaults = await json(await call(`/api/v1/drives/${drive.id}/claim-defaults`, { token: member.token }));
    expect(defaults).toEqual({ student_number: 'B10001', department: '資訊管理學系', grade: 3, from_roster: true });
    const claim = await json(await register(drive, member.token, books.calculus, { department: '資訊管理學系', grade: 3 }));
    expect(claim.student_number).toBe('B10001');

    // A number approved at another school is not this organization's student.
    const elsewhere = await student('B10001', 2);
    expect(await json(await call(`/api/v1/drives/${drive.id}/claim-defaults`, { token: elsewhere.token }))).toEqual({
      student_number: '',
      department: '',
      grade: null,
      from_roster: false,
    });
    expect((await json(await register(drive, elsewhere.token, books.calculus))).student_number).toBe('');
  });

  it("pins the drive on the book's page and marks the book in search, for drives taking registrations only", async () => {
    const { lead, drive, books, tag } = await setup();
    const page = (token?: string) => call(`/api/v1/books?id=${books.calculus}`, { token, headers: { 'X-Region': 'TW' } });

    expect((await json(await page())).drives).toEqual([]);

    await open(drive, lead.token);
    const s = await student();
    await register(drive, s.token, books.calculus);

    const anon = await json(await page());
    expect(anon.drives).toEqual([
      expect.objectContaining({ id: drive.id, title: '期初贈書', remaining: 2, claimants: 1, open: true, my_claim: null }),
    ]);
    expect(anon.drives[0].organization.display_name).toContain('國立臺灣大學');
    expect(JSON.stringify(anon.drives)).not.toContain('D000001');
    const own = await json(await page(s.token));
    expect(own.drives[0].my_claim).toMatchObject({ status: 'registered' });

    const found = await json(
      await call(`/api/v1/search/books?q=${encodeURIComponent(`Calculus ${tag}`)}`, { headers: { 'X-Region': 'TW' } }),
    );
    const hit = found.results.find((r: Json) => r.id === books.calculus);
    expect(hit).toMatchObject({ driveCopies: 2 });
  });

  it('lists a drive with more titles than D1 binds parameters in one statement', async () => {
    const { lead, drive } = await setup();
    // D1 refuses a statement with more than 100 bound parameters: 120 titles, one copy each, past the 3 setup took in.
    const now = new Date().toISOString();
    const rows = Array.from({ length: 120 }, (_, i) => ({ book: crypto.randomUUID(), copy: crypto.randomUUID(), i }));
    await env.DB.batch(
      rows.flatMap((r) => [
        env.DB.prepare(`INSERT INTO books (id, region_code, title, source, created_at) VALUES (?, 'TW', ?, 'manual', ?)`).bind(
          r.book,
          `Bulk ${String(r.i).padStart(3, '0')}`,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO drive_copies (id, drive_id, book_id, shelf_no, condition, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'new', 'in_stock', ?, ?)`,
        ).bind(r.copy, drive.id, r.book, 1000 + r.i, now, now),
      ]),
    );
    await open(drive, lead.token);

    const page = await call(`/api/v1/drives/${drive.id}/public`);
    expect(page.status).toBe(200);
    expect((await json(page)).titles).toHaveLength(123);
    const list = await call('/api/v1/drives/open?school=NTU&titles=12', { headers: { 'X-Region': 'TW' } });
    expect(list.status).toBe(200);
    const ours = (await json(list)).results.find((d: Json) => d.id === drive.id);
    expect(ours).toMatchObject({ titles: 123, copies: 124 });
    expect(ours.preview).toHaveLength(12);
    const copies = await call(`/api/v1/drives/${drive.id}/copies?page_size=200`, { token: lead.token });
    expect(copies.status).toBe(200);
    expect((await json(copies)).results).toHaveLength(124);
  });
});
