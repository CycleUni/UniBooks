import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, createUser, login, seedReference } from '../accounts/helpers';
import { purgeLapsedMembers } from '../../src/jobs';
import { deleteAccount } from '../../src/services/accounts/users';
import { academicYearEnd, validateMember } from '../../src/services/orgs/roster';
import { canonicalDepartment } from '../../src/services/listings/places';

const CATS = [
  {
    row: {
      departments: JSON.stringify([
        { name: '資訊管理學系', aliases: ['資管'] },
        { name: '會計資訊系', aliases: [] },
      ]),
    },
  },
  {
    row: {
      departments: JSON.stringify([
        { name: '應用英語系', aliases: ['應英'], translations: { en: { name: 'Applied English', aliases: [] } } },
      ]),
    },
  },
];

let n = 0;
async function account(role = 'user') {
  const email = `org-${role}-${++n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const id = await createUser(email, { role });
  const { access } = await login(email);
  return { id, email, token: access };
}

async function seedDepartments() {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO categories (id, region_code, slug, title, departments, sort_order, is_active)
     VALUES (900, 'TW', 'mgmt', 'Management', ?, 0, 1)`,
  )
    .bind(CATS[0].row.departments)
    .run();
}

describe('roster rows', () => {
  it('reads a department by any spelling, and keeps unknown text with a warning', () => {
    expect(canonicalDepartment(CATS, '資管系')).toBe('資訊管理學系');
    expect(canonicalDepartment(CATS, ' 資訊管理系 ')).toBe('資訊管理學系');
    expect(canonicalDepartment(CATS, 'applied english')).toBe('應用英語系');
    expect(canonicalDepartment(CATS, '資')).toBeNull();
    const check = validateMember({ student_number: ' c11 0001 '.replace(/ /g, ''), department: '太空系' }, CATS);
    expect(check.member?.studentNumber).toBe('C110001');
    expect(check.member?.department).toBe('太空系');
    expect(check.warnings).toEqual(['org.warnDepartmentUnlisted']);
  });

  it('defaults the end of membership to the end of the academic year', () => {
    expect(academicYearEnd(new Date('2026-11-25T00:00:00Z'))).toBe('2027-07-31');
    expect(academicYearEnd(new Date('2027-03-01T00:00:00Z'))).toBe('2027-07-31');
    expect(academicYearEnd(new Date('2027-08-01T00:00:00Z'))).toBe('2028-07-31');
  });

  it('refuses a bad number, grade or date', () => {
    const now = new Date('2026-11-25T00:00:00Z');
    expect(validateMember({ student_number: 'ab' }, CATS, now).errors).toContain('org.errStudentNumber');
    expect(validateMember({ student_number: 'C1100', grade: 9 }, CATS, now).errors).toContain('org.errGrade');
    expect(validateMember({ student_number: 'C1100', grade: '2' }, CATS, now).member?.grade).toBe(2);
    expect(validateMember({ student_number: 'C1100', grade: '大三' }, CATS, now).member?.grade).toBe(3);
    expect(validateMember({ student_number: 'C1100', grade: '二年級' }, CATS, now).member?.grade).toBe(2);
    expect(validateMember({ student_number: 'C1100', grade: '碩一' }, CATS, now).errors).toContain('org.errGrade');
    expect(validateMember({ student_number: 'C1100', valid_until: '2027/7/31' }, CATS, now).member?.validUntil).toBe('2027-07-31');
    expect(validateMember({ student_number: 'C1100', valid_until: '2026-02-30' }, CATS, now).errors).toContain('org.errValidUntil');
    expect(validateMember({ student_number: 'C1100', valid_until: '2026-01-01' }, CATS, now).errors).toContain('org.errValidUntil');
  });
});

describe('organizations', () => {
  beforeEach(async () => {
    await seedReference();
    await seedDepartments();
  });

  async function createOrg(token: string, school = 1, name = '學生會') {
    const res = await call('/api/v1/admin/organizations', { token, body: { school, name } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; display_name: string; admins: { id: string }[] };
  }

  it('staff create an organization in their region and name its admins', async () => {
    const root = await account('admin');
    const org = await createOrg(root.token);
    expect(org.display_name).toBe('國立臺灣大學 學生會');

    const dup = await call('/api/v1/admin/organizations', { token: root.token, body: { school: 1, name: '學生會' } });
    expect(dup.status).toBe(409);

    const lead = await account();
    const added = await call(`/api/v1/admin/organizations/${org.id}/admins`, {
      token: root.token,
      body: { email: lead.email.toUpperCase() },
    });
    expect(added.status).toBe(200);
    expect(((await added.json()) as typeof org).admins.map((a) => a.id)).toEqual([lead.id]);

    const missing = await call(`/api/v1/admin/organizations/${org.id}/admins`, {
      token: root.token,
      body: { email: 'nobody@example.com' },
    });
    expect(missing.status).toBe(404);

    const me = (await (await call('/api/v1/auth/me', { token: lead.token })).json()) as { organizations: { id: string }[] };
    expect(me.organizations.map((o) => o.id)).toEqual([org.id]);

    // An inactive organization drops out of /me and its API.
    await call(`/api/v1/admin/organizations/${org.id}`, { token: root.token, method: 'PATCH', body: { is_active: false } });
    const after = (await (await call('/api/v1/auth/me', { token: lead.token })).json()) as { organizations: unknown[] };
    expect(after.organizations).toEqual([]);
    expect((await call(`/api/v1/orgs/${org.id}`, { token: lead.token })).status).toBe(404);
  });

  it('keeps a school with organizations, and drops a deleted account from its admins', async () => {
    const root = await account('admin');
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO schools (id, region_code, code, name, email_domain, translations, is_active, created_at)
       VALUES (77, 'TW', 'ORGSCH', 'Org School', 'orgsch.edu.tw', '{}', 1, ?)`,
    )
      .bind(now)
      .run();
    const org = await createOrg(root.token, 77);
    const res = await call('/api/v1/admin/schools/77', { token: root.token, method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('admin.errSchoolHasOrganizations');

    const lead = await account();
    await call(`/api/v1/admin/organizations/${org.id}/admins`, { token: root.token, body: { email: lead.email } });
    await deleteAccount(env, lead.id);
    const { results } = await env.DB.prepare('SELECT user_id FROM organization_admins WHERE organization_id = ?').bind(org.id).all();
    expect(results).toEqual([]);
  });

  it('keeps staff to their own regions', async () => {
    const staff = await account('staff');
    await env.DB.prepare("INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, 'HK')").bind(staff.id).run();
    const res = await call('/api/v1/admin/organizations', { token: staff.token, body: { school: 1, name: '學生會' } });
    expect(res.status).toBe(403);
    const ok = await call('/api/v1/admin/organizations', { token: staff.token, body: { school: 2, name: 'Students Union' } });
    expect(ok.status).toBe(201);
    const list = (await (await call('/api/v1/admin/organizations', { token: staff.token })).json()) as { results: { region: string }[] };
    expect(list.results.every((o) => o.region === 'HK')).toBe(true);
  });

  it('lets only its admins import, preview and edit the roster', async () => {
    const root = await account('admin');
    const org = await createOrg(root.token, 1, `系學會-${n}`);
    const lead = await account();
    const outsider = await account();
    await call(`/api/v1/admin/organizations/${org.id}/admins`, { token: root.token, body: { email: lead.email } });

    const rows = [
      { student_number: 'c110001', name: '王小明', department: '資管', grade: 2 },
      { student_number: 'C110002', name: '李小華', department: '太空系' },
    ];
    expect((await call(`/api/v1/orgs/${org.id}/members/import`, { token: outsider.token, body: { mode: 'merge', rows } })).status).toBe(
      404,
    );

    const preview = await call(`/api/v1/orgs/${org.id}/members/import`, { token: lead.token, body: { mode: 'merge', rows } });
    const p = (await preview.json()) as {
      committed: boolean;
      summary: Record<string, number>;
      issues: { line: number; warnings: string[] }[];
    };
    expect(p.committed).toBe(false);
    expect(p.summary).toMatchObject({ rows: 2, added: 2, errors: 0, warnings: 1 });
    expect(p.issues).toEqual([expect.objectContaining({ line: 2, warnings: ['org.warnDepartmentUnlisted'] })]);
    expect((await (await call(`/api/v1/orgs/${org.id}`, { token: lead.token })).json()) as { member_count: number }).toMatchObject({
      member_count: 0,
    });

    const bad = await call(`/api/v1/orgs/${org.id}/members/import`, {
      token: lead.token,
      body: { mode: 'merge', commit: true, rows: [...rows, { student_number: 'C110001' }] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('org.errImportHasErrors');

    const done = await call(`/api/v1/orgs/${org.id}/members/import`, { token: lead.token, body: { mode: 'merge', commit: true, rows } });
    expect(((await done.json()) as { committed: boolean }).committed).toBe(true);
    const list = (await (await call(`/api/v1/orgs/${org.id}/members?q=資訊`, { token: lead.token })).json()) as {
      count: number;
      results: { student_number: string; department: string; grade: number; valid_until: string }[];
    };
    expect(list.count).toBe(1);
    expect(list.results[0]).toMatchObject({
      student_number: 'C110001',
      department: '資訊管理學系',
      grade: 2,
      valid_until: academicYearEnd(),
    });

    // Same rows again: nothing changes. Replace with one row: the other goes.
    const again = (await (
      await call(`/api/v1/orgs/${org.id}/members/import`, { token: lead.token, body: { mode: 'merge', rows } })
    ).json()) as {
      summary: Record<string, number>;
    };
    expect(again.summary).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    const replaced = (await (
      await call(`/api/v1/orgs/${org.id}/members/import`, {
        token: lead.token,
        body: { mode: 'replace', commit: true, rows: [{ ...rows[0], grade: 3 }] },
      })
    ).json()) as { summary: Record<string, number> };
    expect(replaced.summary).toMatchObject({ updated: 1, removed: 1 });

    const put = await call(`/api/v1/orgs/${org.id}/members/c110009`, { token: lead.token, method: 'PUT', body: { name: '陳', grade: 1 } });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ student_number: 'C110009', grade: 1 });
    const badPut = await call(`/api/v1/orgs/${org.id}/members/C110009`, { token: lead.token, method: 'PUT', body: { grade: 0 } });
    expect(((await badPut.json()) as { error: { fields: Record<string, string[]> } }).error.fields).toEqual({ grade: ['org.errGrade'] });
    expect((await call(`/api/v1/orgs/${org.id}/members/C110009`, { token: lead.token, method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/v1/orgs/${org.id}/members/C110009`, { token: lead.token, method: 'DELETE' })).status).toBe(404);
  });

  it('drops lapsed members in the nightly cleanup', async () => {
    const root = await account('admin');
    const org = await createOrg(root.token, 1, `社團-${n}`);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organization_members (organization_id, student_number, valid_until, created_at, updated_at) VALUES (?, 'OLD1', '2020-07-31', ?, ?)`,
      ).bind(org.id, now, now),
      env.DB.prepare(
        `INSERT INTO organization_members (organization_id, student_number, valid_until, created_at, updated_at) VALUES (?, 'NEW1', '2999-07-31', ?, ?)`,
      ).bind(org.id, now, now),
    ]);
    expect(await purgeLapsedMembers(env)).toBeGreaterThanOrEqual(1);
    const { results } = await env.DB.prepare('SELECT student_number FROM organization_members WHERE organization_id = ?')
      .bind(org.id)
      .all();
    expect(results.map((r) => r.student_number)).toEqual(['NEW1']);
  });
});
