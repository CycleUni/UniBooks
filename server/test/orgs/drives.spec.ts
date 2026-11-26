import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, createUser, login, seedReference } from '../accounts/helpers';
import { purgeClosedDriveDonors, DRIVE_DONOR_RETENTION_DAYS } from '../../src/jobs';
import { deleteUnusedBooks } from '../../src/services/catalog/unused';

let n = 0;
async function account(role = 'user') {
  const email = `drive-${role}-${++n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const id = await createUser(email, { role });
  const { access } = await login(email);
  return { id, email, token: access };
}

type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;

describe('book drives', () => {
  beforeEach(async () => {
    await seedReference();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO categories (id, region_code, slug, title, departments, sort_order, is_active)
       VALUES (901, 'TW', 'mgmt-d', 'Management', '[{"name":"資訊管理學系","aliases":["資管"]}]', 0, 1)`,
    ).run();
  });

  /** An organization with an admin, and a drive it runs. */
  async function setup() {
    const root = await account('admin');
    const org = await json(await call('/api/v1/admin/organizations', { token: root.token, body: { school: 1, name: `學生會-${n}` } }));
    const lead = await account();
    await call(`/api/v1/admin/organizations/${org.id}/admins`, { token: root.token, body: { email: lead.email } });
    const res = await call('/api/v1/drives', { token: lead.token, body: { organization: org.id, title: '期末收書' } });
    expect(res.status).toBe(201);
    const drive = await json(res);
    return { root, org, lead, drive };
  }

  const book = { title: 'Calculus', authors: 'Stewart', isbn13: '9780306406157', source: 'manual' };

  it('lets the organization admins create a drive and name its staff; nobody else sees it', async () => {
    const { org, lead, drive } = await setup();
    expect(drive).toMatchObject({ status: 'intake', role: 'admin', region: 'TW', counts: { copies: 0, staff: 0 } });
    expect(drive.organization.display_name).toContain('國立臺灣大學');

    const outsider = await account();
    expect((await call('/api/v1/drives', { token: outsider.token, body: { organization: org.id, title: 'x' } })).status).toBe(404);
    expect((await call(`/api/v1/drives/${drive.id}`, { token: outsider.token })).status).toBe(404);

    const helper = await account();
    const staff = await json(await call(`/api/v1/drives/${drive.id}/staff`, { token: lead.token, body: { email: helper.email } }));
    expect(staff.results.map((s: Json) => s.id)).toEqual([helper.id]);
    expect((await call(`/api/v1/drives/${drive.id}/staff`, { token: lead.token, body: { email: 'nobody@example.com' } })).status).toBe(404);

    const mine = await json(await call('/api/v1/drives', { token: helper.token }));
    expect(mine.results).toEqual([expect.objectContaining({ id: drive.id, role: 'staff' })]);
    const me = await json(await call('/api/v1/auth/me', { token: helper.token }));
    expect(me.staffed_drives).toEqual([expect.objectContaining({ id: drive.id, title: '期末收書' })]);

    // Staff take books in; the settings and the staff are the admins'.
    expect((await call(`/api/v1/drives/${drive.id}`, { token: helper.token, method: 'PATCH', body: { title: 'x' } })).status).toBe(403);
    expect((await call(`/api/v1/drives/${drive.id}/staff`, { token: helper.token })).status).toBe(403);
  });

  it('opens book drives and draws to an organization as staff choose, and names it to anyone', async () => {
    const { root, org, lead, drive } = await setup();
    // A new organization gets book drives only.
    expect(org.features).toEqual({ draws: false, drives: true });
    const me = await json(await call('/api/v1/auth/me', { token: lead.token }));
    expect(me.organizations).toEqual([expect.objectContaining({ id: org.id, features: { draws: false, drives: true } })]);

    // Without book drives, its drives are gone for its admins and none can be made.
    const off = await json(
      await call(`/api/v1/admin/organizations/${org.id}`, {
        token: root.token,
        method: 'PATCH',
        body: { features: { drives: false, draws: true } },
      }),
    );
    expect(off.features).toEqual({ draws: true, drives: false });
    expect((await call(`/api/v1/drives/${drive.id}`, { token: lead.token })).status).toBe(404);
    expect((await json(await call('/api/v1/drives', { token: lead.token }))).results).toEqual([]);
    const refused = await call('/api/v1/drives', { token: lead.token, body: { organization: org.id, title: 'x' } });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe('org.errDrivesOff');
    expect(
      (await call(`/api/v1/admin/organizations/${org.id}`, { token: root.token, method: 'PATCH', body: { features: { drives: 'yes' } } }))
        .status,
    ).toBe(400);

    // Its name, for the event system's public pages: no sign-in, active ones only.
    const names = await json(await call(`/api/v1/orgs/names?ids=${org.id},${crypto.randomUUID()},bad`));
    expect(Object.keys(names)).toEqual([org.id]);
    expect(names[org.id]).toContain('國立臺灣大學');
    await call(`/api/v1/admin/organizations/${org.id}`, { token: root.token, method: 'PATCH', body: { is_active: false } });
    expect(await json(await call(`/api/v1/orgs/names?ids=${org.id}`))).toEqual({});
  });

  it('takes books in with consecutive shelf numbers, and stops once the drive closes', async () => {
    const { lead, drive } = await setup();
    const first = await call(`/api/v1/drives/${drive.id}/copies`, {
      token: lead.token,
      body: {
        book,
        condition: 'like_new',
        donor_student_number: 'c110001',
        donor_department: '資管',
        target_department: '資管系',
        target_grade: '大一',
      },
    });
    expect(first.status).toBe(201);
    const a = await json(first);
    expect(a).toMatchObject({
      shelf_no: 1,
      condition: 'like_new',
      donor_student_number: 'C110001',
      donor_department: '資訊管理學系',
      target_department: '資訊管理學系',
      target_grade: 1,
      status: 'in_stock',
      warnings: [],
    });
    expect(a.book).toMatchObject({ title: 'Calculus', isbn13: '9780306406157' });

    // The same book again, by its id this time, with a department the list lacks.
    const b = await json(
      await call(`/api/v1/drives/${drive.id}/copies`, {
        token: lead.token,
        body: { book_id: a.book.id, condition: 'noted', target_department: '太空系' },
      }),
    );
    expect(b).toMatchObject({ shelf_no: 2, target_department: '太空系', warnings: ['org.warnDepartmentUnlisted'] });

    const bad = await call(`/api/v1/drives/${drive.id}/copies`, {
      token: lead.token,
      body: { book_id: a.book.id, condition: 'mint', target_grade: 9 },
    });
    expect((await json(bad)).error.fields).toEqual({ condition: ['drive.errCondition'], target_grade: ['org.errGrade'] });

    const view = await json(await call(`/api/v1/drives/${drive.id}`, { token: lead.token }));
    expect(view.counts).toMatchObject({ copies: 2, in_stock: 2, titles: 1 });
    const found = await json(await call(`/api/v1/drives/${drive.id}/copies?q=%232`, { token: lead.token }));
    expect(found.results.map((x: Json) => x.shelf_no)).toEqual([2]);

    await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { status: 'closed' } });
    const closed = await call(`/api/v1/drives/${drive.id}/copies`, { token: lead.token, body: { book_id: a.book.id, condition: 'new' } });
    expect((await json(closed)).error.code).toBe('drive.errNotCollecting');
    expect((await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { status: 'claiming' } })).status).toBe(
      400,
    );
  });

  it('corrects, withdraws and removes a copy', async () => {
    const { lead, drive } = await setup();
    const copy = await json(await call(`/api/v1/drives/${drive.id}/copies`, { token: lead.token, body: { book, condition: 'new' } }));
    const edited = await json(
      await call(`/api/v1/drives/${drive.id}/copies/${copy.id}`, {
        token: lead.token,
        method: 'PATCH',
        body: { condition: 'damaged', status: 'withdrawn' },
      }),
    );
    expect(edited).toMatchObject({ condition: 'damaged', status: 'withdrawn' });
    const back = await call(`/api/v1/drives/${drive.id}/copies/${copy.id}`, {
      token: lead.token,
      method: 'PATCH',
      body: { status: 'picked_up' },
    });
    expect((await json(back)).error.code).toBe('drive.errCopyNotOnShelf');
    expect((await call(`/api/v1/drives/${drive.id}/copies/${copy.id}`, { token: lead.token, method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/v1/drives/${drive.id}/copies/${copy.id}`, { token: lead.token, method: 'DELETE' })).status).toBe(404);
  });

  it("fills in a donor's department from the roster, else from an earlier intake", async () => {
    const { org, lead, drive } = await setup();
    await call(`/api/v1/orgs/${org.id}/members/C220001`, {
      token: lead.token,
      method: 'PUT',
      body: { department: '資管', grade: 3, name: '王' },
    });
    const fromRoster = await json(await call(`/api/v1/drives/${drive.id}/students/c220001`, { token: lead.token }));
    expect(fromRoster).toEqual({ student_number: 'C220001', department: '資訊管理學系', grade: 3, source: 'roster' });

    await call(`/api/v1/drives/${drive.id}/copies`, {
      token: lead.token,
      body: { book, condition: 'new', donor_student_number: 'C220002', donor_department: '太空系' },
    });
    const fromHistory = await json(await call(`/api/v1/drives/${drive.id}/students/C220002`, { token: lead.token }));
    expect(fromHistory).toMatchObject({ department: '太空系', source: 'history' });
    expect(await json(await call(`/api/v1/drives/${drive.id}/students/C220003`, { token: lead.token }))).toMatchObject({ source: null });
  });

  it('keeps a book a drive holds, and clears donors a while after the drive closed', async () => {
    const { lead, drive } = await setup();
    const copy = await json(
      await call(`/api/v1/drives/${drive.id}/copies`, {
        token: lead.token,
        body: { book: { title: 'Kept', source: 'manual' }, condition: 'new', donor_student_number: 'C330001', donor_department: '資管' },
      }),
    );
    await env.DB.prepare("UPDATE books SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(copy.book.id).run();
    expect(await deleteUnusedBooks(env, [copy.book.id])).toBe(0);

    await call(`/api/v1/drives/${drive.id}`, { token: lead.token, method: 'PATCH', body: { status: 'closed' } });
    expect(await purgeClosedDriveDonors(env)).toBe(0);
    const later = Date.now() + (DRIVE_DONOR_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    expect(await purgeClosedDriveDonors(env, later)).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare('SELECT donor_student_number, donor_department FROM drive_copies WHERE id = ?').bind(copy.id).first();
    expect(row).toEqual({ donor_student_number: '', donor_department: '' });
  });
});
