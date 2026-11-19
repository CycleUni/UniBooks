import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call as callWorker, seedReference } from '../accounts/helpers';
import { staff, call as callAdmin } from '../ads/helpers';
import { resolveSchoolFromEmail, isValidEduEmail } from '../../src/services/accounts/edu';

let root: { id: string; token: string };

beforeAll(async () => {
  await seedReference();
  root = await staff('mail-domains-root@example.com', { admin: true });
});

async function audits(action: string, targetId?: string | number) {
  const { results } = await env.DB.prepare(
    'SELECT target_type, target_id, actor_id, details FROM audit_events WHERE action = ? ORDER BY rowid DESC',
  )
    .bind(action)
    .all<{ target_type: string; target_id: string; actor_id: string; details: string }>();
  return results
    .filter((r) => targetId === undefined || r.target_id === String(targetId))
    .map((r) => ({ ...r, meta: JSON.parse(r.details) }));
}

describe('school mailbox domains: matching in resolveSchoolFromEmail & isValidEduEmail', () => {
  it('resolves school for extra domains including a non-subdomain domain and subdomains of extra domains', async () => {
    // Insert a school with an extra subdomain and an extra non-subdomain domain
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO schools (region_code, code, name, email_domain, email_domains, student_email_domain, google_domains, is_active, created_at)
       VALUES ('TW', 'CHIHLEE_TEST', 'Chihlee Test University', 'chihlee-test.edu.tw', ?, 'gm.chihlee-test.edu.tw', '["gm.chihlee-test.edu.tw"]', 1, ?)`,
    )
      .bind(JSON.stringify(['gm.chihlee-test.edu.tw', 'mail.chihlee-test.edu.tw', 'custom-mailbox.tw']), now)
      .run();

    // Primary domain
    const r1 = await resolveSchoolFromEmail(env, 'user@chihlee-test.edu.tw');
    expect(r1?.school.name).toBe('Chihlee Test University');
    expect(r1?.regionCode).toBe('TW');
    expect(await isValidEduEmail(env, 'user@chihlee-test.edu.tw')).toBe(true);

    // Unlisted subdomain of primary domain
    const r2 = await resolveSchoolFromEmail(env, 'user@dept.chihlee-test.edu.tw');
    expect(r2?.school.name).toBe('Chihlee Test University');

    // Extra listed subdomain
    const r3 = await resolveSchoolFromEmail(env, 'student@gm.chihlee-test.edu.tw');
    expect(r3?.school.name).toBe('Chihlee Test University');

    // Subdomain of extra listed subdomain
    const r4 = await resolveSchoolFromEmail(env, 'student@sub.gm.chihlee-test.edu.tw');
    expect(r4?.school.name).toBe('Chihlee Test University');

    // Extra listed non-subdomain domain
    const r5 = await resolveSchoolFromEmail(env, 'student@custom-mailbox.tw');
    expect(r5?.school.name).toBe('Chihlee Test University');

    // Subdomain of non-subdomain domain
    const r6 = await resolveSchoolFromEmail(env, 'student@mail.custom-mailbox.tw');
    expect(r6?.school.name).toBe('Chihlee Test University');

    // Unrelated domain fails
    const r7 = await resolveSchoolFromEmail(env, 'student@not-a-school.com');
    expect(r7).toBeNull();
  });
});

describe('school mailbox domains: Admin CRUD and audit', () => {
  it('creates, reads, patches and deletes a school with the three mailbox domain fields and audit trail', async () => {
    // 1. Create
    const createRes = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'Mailbox Uni',
        email_domain: 'mailbox-uni.edu.tw',
        region: 'TW',
        email_domains: ['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw'],
        student_email_domain: 'gm.mailbox-uni.edu.tw',
        google_domains: ['gm.mailbox-uni.edu.tw'],
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as any;
    expect(created.email_domain).toBe('mailbox-uni.edu.tw');
    expect(created.email_domains).toEqual(['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw']);
    expect(created.student_email_domain).toBe('gm.mailbox-uni.edu.tw');
    expect(created.google_domains).toEqual(['gm.mailbox-uni.edu.tw']);

    // Check audit
    const [createAudit] = await audits('admin.school_created', created.id);
    expect(createAudit.meta.email_domain).toBe('mailbox-uni.edu.tw');
    expect(createAudit.meta.email_domains).toEqual(['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw']);
    expect(createAudit.meta.student_email_domain).toBe('gm.mailbox-uni.edu.tw');
    expect(createAudit.meta.google_domains).toEqual(['gm.mailbox-uni.edu.tw']);

    // 2. Read detail
    const getRes = await callAdmin(`/api/v1/admin/schools/${created.id}`, { token: root.token });
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as any;
    expect(detail.email_domains).toEqual(['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw']);
    expect(detail.student_email_domain).toBe('gm.mailbox-uni.edu.tw');
    expect(detail.google_domains).toEqual(['gm.mailbox-uni.edu.tw']);

    // 3. Patch
    const patchRes = await callAdmin(`/api/v1/admin/schools/${created.id}`, {
      method: 'PATCH',
      token: root.token,
      body: {
        email_domains: ['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw', 'o365.mailbox-uni.edu.tw'],
        student_email_domain: 'o365.mailbox-uni.edu.tw',
        google_domains: ['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw'],
      },
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as any;
    expect(patched.email_domains).toEqual(['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw', 'o365.mailbox-uni.edu.tw']);
    expect(patched.student_email_domain).toBe('o365.mailbox-uni.edu.tw');
    expect(patched.google_domains).toEqual(['gm.mailbox-uni.edu.tw', 'mail.mailbox-uni.edu.tw']);

    // Check patch audit
    const [patchAudit] = await audits('admin.school_updated', created.id);
    expect(patchAudit.meta.changes.emailDomains).toBeDefined();
    expect(patchAudit.meta.changes.studentEmailDomain).toEqual({
      before: 'gm.mailbox-uni.edu.tw',
      after: 'o365.mailbox-uni.edu.tw',
    });
    expect(patchAudit.meta.changes.googleDomains).toBeDefined();

    // 4. Delete
    const delRes = await callAdmin(`/api/v1/admin/schools/${created.id}`, {
      method: 'DELETE',
      token: root.token,
    });
    expect(delRes.status).toBe(204);
  });
});

describe('school mailbox domains: validation and conflict rejection', () => {
  it('rejects student_email_domain and google_domains that are not accepted domains', async () => {
    // Unrelated student_email_domain
    const r1 = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'Invalid Student Domain Uni',
        email_domain: 'inv-student.edu.tw',
        region: 'TW',
        email_domains: ['mail.inv-student.edu.tw'],
        student_email_domain: 'random-unaccepted.edu.tw',
      },
    });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as any).error.fields.student_email_domain).toBeDefined();

    // Unrelated google_domains
    const r2 = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'Invalid Google Domain Uni',
        email_domain: 'inv-google.edu.tw',
        region: 'TW',
        email_domains: ['mail.inv-google.edu.tw'],
        google_domains: ['gmail.com'], // non campus
      },
    });
    expect(r2.status).toBe(400);

    const r3 = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'Invalid Google Domain Uni 2',
        email_domain: 'inv-google2.edu.tw',
        region: 'TW',
        email_domains: ['mail.inv-google2.edu.tw'],
        google_domains: ['random-other.edu.tw'],
      },
    });
    expect(r3.status).toBe(400);
    expect(((await r3.json()) as any).error.fields.google_domains).toBeDefined();
  });

  it('rejects duplicate or overlapping domains across schools in email_domains', async () => {
    // School 1 has primary domain sch1.edu.tw and extra domain extra.sch1.edu.tw
    const s1 = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'School One',
        email_domain: 'sch1.edu.tw',
        region: 'TW',
        email_domains: ['extra.sch1.edu.tw'],
      },
    });
    expect(s1.status).toBe(201);

    // School 2 attempts to use exact same extra domain in its email_domains
    const s2Dup = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'School Two Dup',
        email_domain: 'sch2.edu.tw',
        region: 'TW',
        email_domains: ['extra.sch1.edu.tw'],
      },
    });
    expect(s2Dup.status).toBe(400);
    expect(((await s2Dup.json()) as any).error.fields.email_domains).toBeDefined();

    // School 2 attempts to use a subdomain of School 1's domain in its email_domains
    const s2Sub = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'School Two Sub',
        email_domain: 'sch2.edu.tw',
        region: 'TW',
        email_domains: ['sub.extra.sch1.edu.tw'],
      },
    });
    expect(s2Sub.status).toBe(400);
    expect(((await s2Sub.json()) as any).error.fields.email_domains).toContain('admin.errSchoolDomainOverlaps');

    // School 2 attempts to use a parent of School 1's extra domain as its primary email_domain
    const s2Parent = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: {
        name: 'School Two Parent',
        email_domain: 'sch1.edu.tw', // already exists as primary
        region: 'TW',
      },
    });
    expect(s2Parent.status).toBe(400);
  });
});

describe('school mailbox domains: bulk import keep and modify semantics', () => {
  it('applies bulk import with mailbox domains, keeps them on re-import with omitted keys, and modifies when changed', async () => {
    const item1 = {
      name: 'Bulk Uni A',
      email_domain: 'bulk-a.edu.tw',
      email_domains: ['gm.bulk-a.edu.tw', 'mail.bulk-a.edu.tw'],
      student_email_domain: 'gm.bulk-a.edu.tw',
      google_domains: ['gm.bulk-a.edu.tw'],
    };

    // 1. Initial apply
    const apply1 = await callAdmin('/api/v1/admin/schools/bulk?region=TW', {
      token: root.token,
      body: { action: 'apply', items: [item1] },
    });
    expect(apply1.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM schools WHERE email_domain = ?').bind('bulk-a.edu.tw').first<any>();
    expect(JSON.parse(row.email_domains)).toEqual(['gm.bulk-a.edu.tw', 'mail.bulk-a.edu.tw']);
    expect(row.student_email_domain).toBe('gm.bulk-a.edu.tw');
    expect(JSON.parse(row.google_domains)).toEqual(['gm.bulk-a.edu.tw']);

    // 2. Re-import with omitted keys (missing keys keep stored value)
    const itemOmitted = {
      name: 'Bulk Uni A',
      email_domain: 'bulk-a.edu.tw',
      // email_domains, student_email_domain, google_domains are missing
    };
    const previewOmitted = await callAdmin('/api/v1/admin/schools/bulk?region=TW', {
      token: root.token,
      body: { action: 'preview', items: [itemOmitted] },
    });
    expect(previewOmitted.status).toBe(200);
    const prevBody = (await previewOmitted.json()) as any;
    expect(prevBody.unchanged.length).toBe(1);
    expect(prevBody.modified.length).toBe(0);

    // 3. Re-import with changed values -> reported in modified diff
    const itemModified = {
      name: 'Bulk Uni A',
      email_domain: 'bulk-a.edu.tw',
      email_domains: ['gm.bulk-a.edu.tw', 'mail.bulk-a.edu.tw', 'new.bulk-a.edu.tw'],
      student_email_domain: 'mail.bulk-a.edu.tw',
      google_domains: ['gm.bulk-a.edu.tw', 'mail.bulk-a.edu.tw'],
    };
    const previewMod = await callAdmin('/api/v1/admin/schools/bulk?region=TW', {
      token: root.token,
      body: { action: 'preview', items: [itemModified] },
    });
    expect(previewMod.status).toBe(200);
    const modBody = (await previewMod.json()) as any;
    expect(modBody.modified.length).toBe(1);
    expect(modBody.modified[0].old.student_email_domain).toBe('gm.bulk-a.edu.tw');
    expect(modBody.modified[0].new.student_email_domain).toBe('mail.bulk-a.edu.tw');

    // Apply modified
    const applyMod = await callAdmin('/api/v1/admin/schools/bulk?region=TW', {
      token: root.token,
      body: { action: 'apply', items: [itemModified] },
    });
    expect(applyMod.status).toBe(200);

    const rowAfter = await env.DB.prepare('SELECT * FROM schools WHERE email_domain = ?').bind('bulk-a.edu.tw').first<any>();
    expect(JSON.parse(rowAfter.email_domains)).toEqual(['gm.bulk-a.edu.tw', 'mail.bulk-a.edu.tw', 'new.bulk-a.edu.tw']);
    expect(rowAfter.student_email_domain).toBe('mail.bulk-a.edu.tw');
    expect(JSON.parse(rowAfter.google_domains)).toEqual(['gm.bulk-a.edu.tw', 'mail.bulk-a.edu.tw']);
  });
});

describe('school mailbox domains: public metadata payload', () => {
  it('includes student_email_domain (resolved), accepted_domains, and google_domains in /core/metadata', async () => {
    const res = await callWorker('/api/v1/core/metadata?region=TW&lang=zh-TW');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.schools).toBeDefined();
    expect(body.schools.length).toBeGreaterThan(0);

    // For NTU (seeded with empty extra fields), student_email_domain resolves to email_domain
    const ntu = body.schools.find((s: any) => s.code === 'NTU');
    expect(ntu).toBeDefined();
    expect(ntu.student_email_domain).toBe('ntu.edu.tw'); // resolved, never empty
    expect(ntu.accepted_domains).toContain('ntu.edu.tw');
    expect(Array.isArray(ntu.google_domains)).toBe(true);

    // For a school with specific fields
    const custom = body.schools.find((s: any) => s.code === 'CHIHLEE_TEST');
    if (custom) {
      expect(custom.student_email_domain).toBe('gm.chihlee-test.edu.tw');
      expect(custom.accepted_domains).toEqual(
        expect.arrayContaining(['chihlee-test.edu.tw', 'gm.chihlee-test.edu.tw', 'mail.chihlee-test.edu.tw', 'custom-mailbox.tw']),
      );
      expect(custom.google_domains).toEqual(['gm.chihlee-test.edu.tw']);
    }
  });

  it('tells the app which schools require verification in /core/metadata', async () => {
    // Through the admin API, which is how the flag changes and what refreshes the cached list.
    const created = await callAdmin('/api/v1/admin/schools', {
      token: root.token,
      body: { name: 'Strict Uni', email_domain: 'strict-uni.edu.tw', region: 'TW', requires_verification: true },
    });
    expect(created.status).toBe(201);
    const res = await callWorker('/api/v1/core/metadata?region=TW&lang=zh-TW&shape=4');
    const body = (await res.json()) as any;
    const strict = body.schools.find((s: any) => s.email_domain === 'strict-uni.edu.tw');
    expect(strict?.requires_verification).toBe(true);
    for (const s of body.schools) expect(typeof s.requires_verification).toBe('boolean');
  });
});
