import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, seedReference, staff, tokenFor } from '../ads/helpers';
import { call as callWorker, createUser } from '../accounts/helpers';

let root: { id: string; token: string };
let twManager: { id: string; token: string };

beforeAll(async () => {
  await seedReference();
  root = await staff('users-root@example.com', { admin: true });
  twManager = await staff('users-tw@example.com', { regions: ['TW'] });
});

async function verifyIn(userId: string, region: string) {
  await env.DB.prepare(
    'INSERT INTO region_verifications (user_id, region_code, is_manual_verification, verified_at, is_active, created_at) VALUES (?, ?, 1, ?, 1, ?)',
  )
    .bind(userId, region, new Date().toISOString(), new Date().toISOString())
    .run();
}

const setActive = (id: string, token: string, value: boolean) =>
  call(`/api/v1/admin/users/${id}`, { token, method: 'PATCH', body: { is_active: value } });

describe('searching users', () => {
  const search = async (q: string, token: string, showEmail = false) => {
    const res = await call(`/api/v1/admin/users?q=${encodeURIComponent(q)}${showEmail ? '&show_email=true' : ''}`, { token });
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { id: string }[] }).results.map((u) => u.id);
  };

  it('matches emails only for an admin who asked to see them', async () => {
    const id = await createUser('users-search-hidden@example.com');
    expect(await search('search-hidden', root.token)).not.toContain(id);
    expect(await search('search-hidden', root.token, true)).toContain(id);
    expect(await search('search-hidden', twManager.token, true)).not.toContain(id);
  });

  it('matches the user id', async () => {
    const id = await createUser('users-search-uuid@example.com');
    expect(await search(id, twManager.token)).toContain(id);
    expect(await search(id.slice(0, 8), root.token)).toContain(id);
  });
});

describe('switching an account on or off', () => {
  it('lets a region manager switch only accounts verified solely in their regions', async () => {
    const twOnly = await createUser('users-tw-only@example.com');
    await verifyIn(twOnly, 'TW');
    expect((await setActive(twOnly, twManager.token, false)).status).toBe(200);
    expect((await setActive(twOnly, twManager.token, true)).status).toBe(200);

    const both = await createUser('users-tw-hk@example.com');
    await verifyIn(both, 'TW');
    await verifyIn(both, 'HK');
    expect((await setActive(both, twManager.token, false)).status).toBe(403);
    expect((await setActive(both, root.token, false)).status).toBe(200);

    const unverified = await createUser('users-unverified@example.com');
    expect((await setActive(unverified, twManager.token, false)).status).toBe(403);
  });

  it('never activates a sign-up that has not confirmed its email', async () => {
    const pending = await createUser('users-pending@example.com', { active: false, password: null });
    const res = await setActive(pending, root.token, true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'admin.errForbiddenField' } });
  });

  it('grants and revokes staff by role', async () => {
    const someone = await createUser('users-promote@example.com');
    const grant = await call(`/api/v1/admin/managers/${someone}`, { token: root.token, method: 'PATCH', body: { role: 'staff' } });
    expect(grant.status).toBe(200);
    expect(((await grant.json()) as { role: string }).role).toBe('staff');
    expect((await call(`/api/v1/admin/managers/${someone}`, { token: root.token, method: 'PATCH', body: { role: 'admin' } })).status).toBe(
      400,
    );
    expect(
      (await call(`/api/v1/admin/managers/${someone}`, { token: twManager.token, method: 'PATCH', body: { role: 'user' } })).status,
    ).toBe(403);
  });

  it('gives staff the regions a super admin ticks, whatever school they verified', async () => {
    // Never verified anywhere: being a manager is not tied to a school email.
    const manager = await createUser('users-regions@example.com');
    const patch = (body: unknown, token = root.token) => call(`/api/v1/admin/managers/${manager}`, { token, method: 'PATCH', body });

    const granted = (await (await patch({ role: 'staff' })).json()) as any;
    expect(granted.managed_regions).toEqual([]);

    // Lower-case codes are taken as the regions they name; unknown ones are dropped.
    const ticked = (await (await patch({ managed_regions: ['hk', 'TW', 'ZZ'] })).json()) as any;
    expect(ticked.managed_regions).toEqual(['HK', 'TW']);

    const listed = (await (await call(`/api/v1/admin/users?q=${manager}`, { token: root.token })).json()) as any;
    expect(listed.results[0].managed_regions).toEqual(['HK', 'TW']);
    // What the event system reads (its region scope) through /auth/me.
    const me = (await (await callWorker('/api/v1/auth/me', { token: await tokenFor(manager) })).json()) as any;
    expect(me.managed_regions.sort()).toEqual(['HK', 'TW']);

    expect((await patch({ managed_regions: ['HK'] }, twManager.token)).status).toBe(403);
    const cleared = (await (await patch({ managed_regions: [] })).json()) as any;
    expect(cleared.managed_regions).toEqual([]);
  });

  it('lists only accounts with admin rights, and revoking them clears the regions', async () => {
    const promoted = await createUser('users-listed@example.com');
    const plain = await createUser('users-not-listed@example.com');
    await call(`/api/v1/admin/managers/${promoted}`, {
      token: root.token,
      method: 'PATCH',
      body: { role: 'staff', managed_regions: ['TW'] },
    });
    const ids = async () =>
      ((await (await call('/api/v1/admin/users?role=managers&page_size=100', { token: root.token })).json()) as any).results.map(
        (u: any) => u.id,
      );
    expect(await ids()).toContain(promoted);
    expect(await ids()).toContain(root.id);
    expect(await ids()).not.toContain(plain);

    const revoked = (await (
      await call(`/api/v1/admin/managers/${promoted}`, { token: root.token, method: 'PATCH', body: { role: 'user' } })
    ).json()) as any;
    expect(revoked.role).toBe('user');
    expect(revoked.managed_regions).toEqual([]);
    const regrant = (await (
      await call(`/api/v1/admin/managers/${promoted}`, { token: root.token, method: 'PATCH', body: { role: 'staff' } })
    ).json()) as any;
    expect(regrant.managed_regions).toEqual([]);
    expect(await ids()).toContain(promoted);
  });
});

describe("a region manager sees and sets only their regions' standing", () => {
  it("lists and shows only the manager's regions' verifications", async () => {
    const both = await createUser('users-scope-both@example.com');
    await verifyIn(both, 'TW');
    await verifyIn(both, 'HK');
    const mine = (await (await call(`/api/v1/admin/users/${both}`, { token: twManager.token })).json()) as any;
    expect(mine.regions).toEqual(['TW']);
    expect(mine.verifications.map((v: any) => v.region)).toEqual(['TW']);
    const all = (await (await call(`/api/v1/admin/users/${both}`, { token: root.token })).json()) as any;
    expect(all.regions.sort()).toEqual(['HK', 'TW']);
  });

  it("refuses a school from another region for a region's verification", async () => {
    const u = await createUser('users-scope-school@example.com');
    await verifyIn(u, 'TW');
    const patch = (token: string, school: number) =>
      call(`/api/v1/admin/users/${u}`, { token, method: 'PATCH', body: { region: 'TW', school } });
    expect((await patch(twManager.token, 2)).status).toBe(400); // HKU is in HK
    expect((await patch(root.token, 2)).status).toBe(400);
    expect((await patch(twManager.token, 1)).status).toBe(200);
  });
});
