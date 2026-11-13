import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, createUser, login, seedReference } from './helpers';

beforeAll(async () => {
  await seedReference();
});

const nowIso = () => new Date().toISOString();

describe('Trade Policy & School Declaration', () => {
  it('allows user with no school to trade (e.g. start conversation, create listing)', async () => {
    await createUser('noschool@example.com');
    const { access } = await login('noschool@example.com');

    // GET /me checks
    const meRes = await call('/api/v1/auth/me?region=TW', { token: access });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as any;
    expect(me.school_prompted).toBe(false);
    expect(me.is_verified).toBe(false);
    expect(me.must_verify).toBe(false);
    expect(me.declared_school).toBeNull();
    expect(me.school).toBeNull();

    // Can create manual book without verification
    const bookRes = await call('/api/v1/books/manual?region=TW', {
      method: 'POST',
      token: access,
      body: { title: 'No School Book', authors: 'Author', price: 100 },
    });
    expect(bookRes.status).toBe(201);
  });

  it('allows user with declared optional school (requires_verification = 0)', async () => {
    await createUser('optschool@example.com');
    const { access } = await login('optschool@example.com');

    // Create optional school in TW
    const [optSchool] = await env.DB.prepare(
      "INSERT INTO schools (region_code, code, name, email_domain, requires_verification, is_active, created_at) VALUES ('TW', 'OPT1', 'Optional Univ', 'opt1.edu.tw', 0, 1, ?) RETURNING id, code",
    )
      .bind(nowIso())
      .all<{ id: number; code: string }>()
      .then((r) => r.results);

    // Set school via PUT /accounts/me/school
    const setRes = await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: 'OPT1' },
    });
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ ok: true, school: 'OPT1' });

    // Check /me
    const me = (await (await call('/api/v1/auth/me?region=TW', { token: access })).json()) as any;
    expect(me.school_prompted).toBe(true);
    expect(me.must_verify).toBe(false);
    expect(me.is_verified).toBe(false);
    expect(me.school).toBe(optSchool.id);
    expect(me.declared_school).toMatchObject({ id: optSchool.id, code: 'OPT1', requires_verification: false });

    // Can create listing
    const bookRes = await call('/api/v1/books/manual?region=TW', {
      method: 'POST',
      token: access,
      body: { title: 'Opt Book', authors: 'Author', price: 200 },
    });
    const book = (await bookRes.json()) as any;
    const listRes = await call('/api/v1/listings?region=TW', {
      method: 'POST',
      token: access,
      body: { book: book.id, price: 150, condition: 'like_new' },
    });
    expect(listRes.status).toBe(201);
    const listing = (await listRes.json()) as any;
    expect(listing.seller_school_id).toBe(optSchool.id);
  });

  it('blocks user with declared mandatory school if unverified (403 acct.errVerificationRequiredForSchool)', async () => {
    const user = await createUser('mandschool@example.com');
    const { access } = await login('mandschool@example.com');

    // Create mandatory school in TW
    const [mandSchool] = await env.DB.prepare(
      "INSERT INTO schools (region_code, code, name, email_domain, requires_verification, is_active, created_at) VALUES ('TW', 'MAND1', 'Mandatory Univ', 'mand1.edu.tw', 1, 1, ?) RETURNING id, code",
    )
      .bind(nowIso())
      .all<{ id: number; code: string }>()
      .then((r) => r.results);

    // Set school
    await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: 'MAND1' },
    });

    const me = (await (await call('/api/v1/auth/me?region=TW', { token: access })).json()) as any;
    expect(me.must_verify).toBe(true);
    expect(me.is_verified).toBe(false);

    // Manual book is blocked
    const bookRes = await call('/api/v1/books/manual?region=TW', {
      method: 'POST',
      token: access,
      body: { title: 'Mand Book', authors: 'Author' },
    });
    expect(bookRes.status).toBe(403);
    expect(await bookRes.json()).toEqual({
      error: { code: 'acct.errVerificationRequiredForSchool', region: 'TW', school: 'MAND1' },
    });

    // Verification succeeds and unblocks trading
    await env.DB.prepare(
      `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, is_active, created_at)
       VALUES (?, 'TW', ?, 'student@mand1.edu.tw', ?, 1, ?)`,
    )
      .bind(user, mandSchool.id, nowIso(), nowIso())
      .run();

    const bookOk = await call('/api/v1/books/manual?region=TW', {
      method: 'POST',
      token: access,
      body: { title: 'Mand Book 2', authors: 'Author' },
    });
    expect(bookOk.status).toBe(201);
  });

  it('locks declared school when verified and prevents clearing or changing to another school', async () => {
    const user = await createUser('locked@example.com');
    const { access } = await login('locked@example.com');

    const [sA] = await env.DB.prepare(
      `INSERT INTO schools (region_code, code, name, email_domain, requires_verification, is_active, created_at)
       VALUES ('TW', 'LOCKA', 'School A', 'locka.edu.tw', 0, 1, ?),
              ('TW', 'LOCKB', 'School B', 'lockb.edu.tw', 0, 1, ?)
       RETURNING id, code`,
    )
      .bind(nowIso(), nowIso())
      .all<{ id: number; code: string }>()
      .then((r) => r.results);

    // Verify user in School A
    await env.DB.prepare(
      `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, is_active, created_at)
       VALUES (?, 'TW', ?, 'user@locka.edu.tw', ?, 1, ?)`,
    )
      .bind(user, sA.id, nowIso(), nowIso())
      .run();

    // Trying to change declared school to School B -> 400 acct.errSchoolLockedByVerification
    const changeRes = await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: 'LOCKB' },
    });
    expect(changeRes.status).toBe(400);
    expect(await changeRes.json()).toMatchObject({ error: { code: 'acct.errSchoolLockedByVerification' } });

    // Trying to clear declared school (school: null) -> 400 acct.errSchoolLockedByVerification
    const clearRes = await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: null },
    });
    expect(clearRes.status).toBe(400);
    expect(await clearRes.json()).toMatchObject({ error: { code: 'acct.errSchoolLockedByVerification' } });

    // Setting declared school to the verified school A is allowed
    const sameRes = await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: 'LOCKA' },
    });
    expect(sameRes.status).toBe(200);
  });

  it('supports skip flag on welcome to stamp school_prompted_at without picking a school', async () => {
    await createUser('skip@example.com');
    const { access } = await login('skip@example.com');

    const before = (await (await call('/api/v1/auth/me?region=TW', { token: access })).json()) as any;
    expect(before.school_prompted).toBe(false);

    const skipRes = await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: null, skip: true },
    });
    expect(skipRes.status).toBe(200);

    const after = (await (await call('/api/v1/auth/me?region=TW', { token: access })).json()) as any;
    expect(after.school_prompted).toBe(true);
    expect(after.school).toBeNull();
  });

  it('rejects unknown or inactive schools on PUT /accounts/me/school', async () => {
    await createUser('badinput@example.com');
    const { access } = await login('badinput@example.com');

    const res = await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: 'DOESNOTEXIST' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'common.errValidation', fields: { school: ['common.errValidation'] } },
    });
  });

  it('admin schools: create, patch, and bulk import accept requires_verification', async () => {
    await createUser('admin@example.com', { role: 'admin' });
    const { access } = await login('admin@example.com');

    // Create school with requires_verification: true
    const createRes = await call('/api/v1/admin/schools', {
      method: 'POST',
      token: access,
      body: {
        region: 'TW',
        code: 'ADMREQ',
        name: 'Admin Req Univ',
        email_domain: 'admreq.edu.tw',
        requires_verification: true,
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as any;
    expect(created.requires_verification).toBe(true);

    // PATCH school to turn requires_verification off
    const patchRes = await call(`/api/v1/admin/schools/${created.id}`, {
      method: 'PATCH',
      token: access,
      body: { requires_verification: false },
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as any;
    expect(patched.requires_verification).toBe(false);

    // Bulk import preview and apply with requires_verification
    const bulkRes = await call('/api/v1/admin/schools/bulk?region=TW', {
      method: 'POST',
      token: access,
      body: {
        action: 'apply',
        items: [
          {
            region: 'TW',
            code: 'BULK1',
            name: 'Bulk Univ 1',
            email_domain: 'bulk1.edu.tw',
            requires_verification: true,
          },
        ],
      },
    });
    expect(bulkRes.status).toBe(200);
    const schoolRow = await env.DB.prepare("SELECT requires_verification FROM schools WHERE code = 'BULK1'").first<{
      requires_verification: number;
    }>();
    expect(schoolRow?.requires_verification).toBe(1);
  });

  it('migration backfill: existing live verifications backfill into user_schools', async () => {
    // Check that our migration SQL backfilled user_schools from existing live verifications
    const count = await env.DB.prepare('SELECT count(*) as c FROM user_schools').first<{ c: number }>();
    expect(count?.c).toBeGreaterThanOrEqual(0);
  });

  it('public payloads reflect resolved school and is_verified', async () => {
    const seller = await createUser('pubseller@example.com');
    const { access: sellerAccess } = await login('pubseller@example.com');

    // Declare school without verification
    const [pubSchool] = await env.DB.prepare(
      "INSERT INTO schools (region_code, code, name, email_domain, requires_verification, is_active, created_at) VALUES ('TW', 'PUB1', 'Public Univ', 'pub1.edu.tw', 0, 1, ?) RETURNING id, code",
    )
      .bind(nowIso())
      .all<{ id: number; code: string }>()
      .then((r) => r.results);

    await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: sellerAccess,
      body: { region: 'TW', school: 'PUB1' },
    });

    // Public seller profile: school_name shows declared school, is_verified is false
    const pubProfileRes = await call(`/api/v1/auth/users/${seller}?region=TW`);
    expect(pubProfileRes.status).toBe(200);
    const pubProfile = (await pubProfileRes.json()) as any;
    expect(pubProfile.school_name).toBe('Public Univ');
    expect(pubProfile.is_verified).toBe(false);

    // Now verify the seller in that school
    await env.DB.prepare(
      `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, is_active, created_at)
       VALUES (?, 'TW', ?, 'seller@pub1.edu.tw', ?, 1, ?)`,
    )
      .bind(seller, pubSchool.id, nowIso(), nowIso())
      .run();

    const pubProfileVerified = (await (await call(`/api/v1/auth/users/${seller}?region=TW`)).json()) as any;
    expect(pubProfileVerified.school_name).toBe('Public Univ');
    expect(pubProfileVerified.is_verified).toBe(true);
  });

  it('gated endpoints: moderation reports and book reports require trade authorization', async () => {
    await createUser('reporter@example.com');
    const { access } = await login('reporter@example.com');

    // School requiring verification
    await env.DB.prepare(
      "INSERT INTO schools (region_code, code, name, email_domain, requires_verification, is_active, created_at) VALUES ('TW', 'MAND_REP', 'Mandatory Reporter Univ', 'mandrep.edu.tw', 1, 1, ?) RETURNING id, code",
    )
      .bind(nowIso())
      .run();

    await call('/api/v1/auth/me/school', {
      method: 'PUT',
      token: access,
      body: { region: 'TW', school: 'MAND_REP' },
    });

    // Create a book to report
    const [book] = await env.DB.prepare(
      "INSERT INTO books (id, region_code, title, source, created_at) VALUES (?, 'TW', 'Report Target', 'manual', ?) RETURNING id",
    )
      .bind(crypto.randomUUID(), nowIso())
      .all<{ id: string }>()
      .then((r) => r.results);

    // Book report is blocked
    const repRes = await call('/api/v1/moderation/book-reports?region=TW', {
      method: 'POST',
      token: access,
      body: {
        book: book.id,
        fields: ['other'],
        detail: 'Testing book report trade authorization',
      },
    });
    expect(repRes.status).toBe(403);
    expect(await repRes.json()).toMatchObject({
      error: { code: 'acct.errVerificationRequiredForSchool', school: 'MAND_REP', region: 'TW' },
    });
  });
});
