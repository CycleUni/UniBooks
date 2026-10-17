import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { app } from '../../src/index';
import * as ott from '../../src/services/accounts/oneTimeTokens';
import { ROTATION_GRACE_SECONDS } from '../../src/services/accounts/tokens';
import { PASSWORD, call, createUser, login, seedReference, sessionOf } from './helpers';
import { hashPassword } from '../../src/services/accounts/passwords';
import { tokenFor } from '../ads/helpers';

beforeAll(async () => {
  await seedReference();
});

const userRow = (email: string) => env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<Record<string, unknown>>();

describe('register and activate', () => {
  it('creates an inactive, lower-cased account and refuses a case-variant duplicate', async () => {
    const res = await call('/api/v1/auth/register', {
      body: { email: 'MixedCase@Example.com', password: PASSWORD, first_name: 'Mixed', last_name: 'Case' },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ code: 'auth.registerSuccess' });
    const row = await userRow('mixedcase@example.com');
    expect(row?.is_active).toBe(0);

    // An unactivated registration proves nothing and is superseded (see the
    // squatting test); an activated account's address is taken.
    await env.DB.prepare('UPDATE users SET is_active = 1 WHERE email = ?').bind('mixedcase@example.com').run();
    const dup = await call('/api/v1/auth/register', {
      body: { email: 'mixedcase@EXAMPLE.com', password: PASSWORD, first_name: 'A', last_name: 'B' },
    });
    expect(dup.status).toBe(400);
    const body = (await dup.json()) as { error: { code: string; fields: Record<string, string[]> } };
    expect(body.error.code).toBe('common.errValidation');
    expect(body.error.fields.email[0]).toBe('acct.errEmailTaken');
  });

  it('rejects an invalid address and a weak password', async () => {
    const bad = await call('/api/v1/auth/register', { body: { email: 'not-an-email', password: PASSWORD } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.fields.email).toEqual(['common.errEmailInvalid']);
    const weak = await call('/api/v1/auth/register', { body: { email: 'weak@example.com', password: '123' } });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as any).error.fields.password.length).toBeGreaterThan(0);
  });

  it('blocks sign-in until the activation link is followed, which signs in once', async () => {
    await call('/api/v1/auth/register', { body: { email: 'pending@example.com', password: PASSWORD, first_name: 'P', last_name: 'U' } });
    const blocked = await call('/api/v1/auth/login', { body: { email: 'pending@example.com', password: PASSWORD } });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: { code: 'auth.errAccountNotActivated' } });

    const row = await userRow('pending@example.com');
    const token = await ott.issue(env, ott.REGISTER, String(row!.id), ott.REGISTER_TTL);
    const ok = await call('/api/v1/auth/verify-registration', { body: { token } });
    expect(ok.status).toBe(200);
    const pair = sessionOf(ok);
    expect(pair.access).toBeTruthy();
    expect(pair.refresh).toBeTruthy();

    const again = await call('/api/v1/auth/verify-registration', { body: { token } });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: { code: 'auth.errInvalidToken' } });
    expect((await call('/api/v1/auth/verify-registration', { body: {} })).status).toBe(400);
  });
});

describe('pre-registration squatting (security)', () => {
  it('leaves no usable password on an unproven row, and lets the owner register over it', async () => {
    const email = 'squatted@example.com';
    // Attacker registers an address they do not own.
    expect((await call('/api/v1/auth/register', { body: { email, password: 'Attacker-Pass-123!' } })).status).toBe(201);
    expect((await userRow(email))?.password_hash).toBeNull();

    // The owner can still register: the unproven row is superseded, not "taken".
    const owner = await call('/api/v1/auth/register', { body: { email, password: PASSWORD } });
    expect(owner.status).toBe(201);

    // Following a registration link activates with *that* link's password only.
    const row = await userRow(email);
    const token = await ott.issue(env, ott.REGISTER, String(row!.id), ott.REGISTER_TTL, { password_hash: await hashPassword(PASSWORD) });
    expect((await call('/api/v1/auth/verify-registration', { body: { token, password: PASSWORD } })).status).toBe(200);
    expect((await call('/api/v1/auth/login', { body: { email, password: 'Attacker-Pass-123!' } })).status).toBe(401);
    expect((await call('/api/v1/auth/login', { body: { email, password: PASSWORD } })).status).toBe(200);

    // Once activated, the address really is taken.
    const late = await call('/api/v1/auth/register', { body: { email, password: 'Attacker-Pass-123!' } });
    expect(late.status).toBe(400);
  });
});

describe('activation needs the registration password (security)', () => {
  it("refuses a squatter's link to an owner who types their own password, and keeps the link usable", async () => {
    const email = 'prehijack@example.com';
    await call('/api/v1/auth/register', { body: { email, password: PASSWORD } });
    const row = await userRow(email);
    // The link a squatter's registration mails: it carries the squatter's password.
    const token = await ott.issue(env, ott.REGISTER, String(row!.id), ott.REGISTER_TTL, {
      password_hash: await hashPassword('Attacker-Pass-123!'),
    });

    const missing = await call('/api/v1/auth/verify-registration', { body: { token } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: { code: 'auth.errActivationPasswordRequired' } });

    const owner = await call('/api/v1/auth/verify-registration', { body: { token, password: PASSWORD } });
    expect(owner.status).toBe(400);
    expect(await owner.json()).toEqual({ error: { code: 'auth.errActivationPasswordMismatch' } });
    expect(owner.headers.get('set-cookie')).toBeNull();
    expect((await userRow(email))?.is_active).toBe(0);

    // A wrong password does not burn the link.
    expect((await call('/api/v1/auth/verify-registration', { body: { token, password: 'Attacker-Pass-123!' } })).status).toBe(200);
  });
});

describe('login', () => {
  it('answers the same for a wrong password and an unknown address, and ignores case', async () => {
    await createUser('login@example.com');
    const wrong = await call('/api/v1/auth/login', { body: { email: 'login@example.com', password: 'nope-nope-1' } });
    const unknown = await call('/api/v1/auth/login', { body: { email: 'ghost@example.com', password: 'nope-nope-1' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: 'auth.errInvalidCredentials' } });
    expect(await unknown.json()).toEqual({ error: { code: 'auth.errInvalidCredentials' } });
    const ok = await call('/api/v1/auth/login', { body: { email: 'LOGIN@example.com', password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect((await call('/api/v1/auth/login', { body: { email: 'login@example.com' } })).status).toBe(400);
  });
});

describe('refresh rotation', () => {
  it('rotates, hands a racing duplicate the same pair, and revokes the family on a late replay', async () => {
    await createUser('rotate@example.com');
    const first = await login('rotate@example.com');

    const a = await call('/api/v1/auth/refresh', { body: { refresh: first.refresh } });
    expect(a.status).toBe(200);
    const pairA = sessionOf(a);
    expect(pairA.refresh).not.toBe(first.refresh);

    // Within the grace window: the SAME stored pair, not a new one.
    const b = await call('/api/v1/auth/refresh', { body: { refresh: first.refresh } });
    expect(b.status).toBe(200);
    expect(sessionOf(b)).toEqual(pairA);

    // Push the rotation out of the grace window: a replay now revokes the chain.
    const past = new Date(Date.now() - (ROTATION_GRACE_SECONDS + 5) * 1000).toISOString();
    await env.DB.prepare('UPDATE refresh_tokens SET rotated_at = ? WHERE rotated_at IS NOT NULL').bind(past).run();
    const replay = await call('/api/v1/auth/refresh', { body: { refresh: first.refresh } });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: { code: 'auth.errTokenRevoked' } });
    const successor = await call('/api/v1/auth/refresh', { body: { refresh: pairA.refresh } });
    expect(successor.status).toBe(401);
  });

  it('leaves other sign-ins alone when one family is revoked', async () => {
    await createUser('two-devices@example.com');
    const one = await login('two-devices@example.com');
    const two = await login('two-devices@example.com');
    await call('/api/v1/auth/refresh', { body: { refresh: one.refresh } });
    const past = new Date(Date.now() - (ROTATION_GRACE_SECONDS + 5) * 1000).toISOString();
    await env.DB.prepare('UPDATE refresh_tokens SET rotated_at = ? WHERE rotated_at IS NOT NULL').bind(past).run();
    expect((await call('/api/v1/auth/refresh', { body: { refresh: one.refresh } })).status).toBe(401);
    expect((await call('/api/v1/auth/refresh', { body: { refresh: two.refresh } })).status).toBe(200);
  });

  it('keeps tokens in HttpOnly cookies, never in the body, and refreshes from the cookie', async () => {
    await createUser('cookie@example.com');
    const res = await call('/api/v1/auth/login', { body: { email: 'cookie@example.com', password: PASSWORD } });
    expect(await res.json()).toMatchObject({ code: 'auth.loginSuccess' });
    const cookies = res.headers.getSetCookie();
    const at = cookies.find((l) => l.startsWith('__Host-ub_at='))!;
    const rt = cookies.find((l) => l.startsWith('__Secure-ub_rt='))!;
    expect(at).toMatch(/HttpOnly/i);
    expect(at).toMatch(/Secure/i);
    expect(at).toMatch(/Path=\//);
    expect(rt).toMatch(/HttpOnly/i);
    expect(rt).toMatch(/SameSite=Strict/i);
    expect(rt).toMatch(/Path=\/api\/v1\/auth\//);
    // A readable hint that lapses just before the access cookie does.
    const hint = cookies.find((l) => l.startsWith('ub_access=1'))!;
    expect(hint).not.toMatch(/HttpOnly/i);
    expect(Number(/Max-Age=(\d+)/i.exec(hint)![1])).toBeLessThan(Number(/Max-Age=(\d+)/i.exec(at)![1]));
    const { access, refresh } = sessionOf(res);
    const me = await call('/api/v1/auth/me', { headers: { Cookie: `__Host-ub_at=${access}` } });
    expect(me.status).toBe(200);
    const rotated = await call('/api/v1/auth/refresh', { method: 'POST', headers: { Cookie: `__Secure-ub_rt=${refresh}` } });
    expect(rotated.status).toBe(200);
    expect(sessionOf(rotated).refresh).toBeTruthy();
  });

  it('refuses cross-site state changes', async () => {
    await createUser('csrf@example.com');
    const { access } = await login('csrf@example.com');
    const cross = await call('/api/v1/auth/logout', {
      body: {},
      headers: { Cookie: `__Host-ub_at=${access}`, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ error: { code: 'auth.errCrossSite' } });
    const same = await call('/api/v1/auth/logout', {
      body: {},
      headers: { Cookie: `__Host-ub_at=${access}`, Origin: 'http://x', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(same.status).toBe(200);
    expect(same.headers.getSetCookie().some((l) => l.startsWith('__Host-ub_at=;') || /__Host-ub_at=.*Max-Age=0/.test(l))).toBe(true);
  });

  it('logout is best effort: revokes via the refresh cookie alone and always clears cookies', async () => {
    await createUser('logout-rt@example.com');
    const { refresh } = await login('logout-rt@example.com');
    const out = await call('/api/v1/auth/logout', { body: {}, headers: { Cookie: `__Secure-ub_rt=${refresh}` } });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((l) => l.startsWith('__Secure-ub_rt=') && /Max-Age=0/i.test(l))).toBe(true);
    // The refresh token was revoked even though no access token was sent.
    expect((await call('/api/v1/auth/refresh', { body: { refresh } })).status).toBe(401);
    // Nothing to sign out of is still a success.
    expect((await call('/api/v1/auth/logout', { body: {} })).status).toBe(200);
  });

  it('a refused refresh clears the session cookies', async () => {
    const res = await call('/api/v1/auth/refresh', { method: 'POST', headers: { Cookie: '__Secure-ub_rt=not-a-token' } });
    expect(res.status).toBe(401);
    const cleared = res.headers.getSetCookie();
    for (const name of ['__Host-ub_at', '__Secure-ub_rt', 'ub_session', 'ub_access']) {
      expect(
        cleared.some((l) => l.startsWith(`${name}=;`) && /Max-Age=0/i.test(l)),
        name,
      ).toBe(true);
    }
  });

  it('rejects a missing, malformed or access token', async () => {
    expect((await call('/api/v1/auth/refresh', { body: {} })).status).toBe(401);
    const garbage = await call('/api/v1/auth/refresh', { body: { refresh: 'garbage' } });
    expect(garbage.status).toBe(401);
    expect(await garbage.json()).toEqual({ error: { code: 'auth.errInvalidToken' } });
    await createUser('access-as-refresh@example.com');
    const { access } = await login('access-as-refresh@example.com');
    expect((await call('/api/v1/auth/refresh', { body: { refresh: access } })).status).toBe(401);
  });

  it('refuses a disabled account', async () => {
    const id = await createUser('disabled-later@example.com');
    const pair = await login('disabled-later@example.com');
    await env.DB.prepare('UPDATE users SET is_active = 0 WHERE id = ?').bind(id).run();
    const res = await call('/api/v1/auth/refresh', { body: { refresh: pair.refresh } });
    expect(res.status).toBe(403);
  });
});

describe('logout', () => {
  it('revokes the refresh token, or every one with all_devices', async () => {
    await createUser('logout@example.com');
    const a = await login('logout@example.com');
    const b = await login('logout@example.com');
    const res = await call('/api/v1/auth/logout', { body: { refresh: a.refresh }, token: a.access });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 'auth.logoutSuccess' });
    expect((await call('/api/v1/auth/refresh', { body: { refresh: a.refresh } })).status).toBe(401);
    expect((await call('/api/v1/auth/refresh', { body: { refresh: b.refresh } })).status).toBe(200);

    const c = await login('logout@example.com');
    await call('/api/v1/auth/logout', { body: { all_devices: true }, token: c.access });
    expect((await call('/api/v1/auth/refresh', { body: { refresh: c.refresh } })).status).toBe(401);
    expect((await call('/api/v1/auth/logout', { body: { refresh: 'junk' }, token: c.access })).status).toBe(200);
  });
});

describe('passwords', () => {
  it('a Google-only account cannot add a password from its session', async () => {
    const id = await createUser('google-only@example.com', { googleId: 'g-only', password: null });
    const res = await call('/api/v1/auth/password', { body: { new_password: 'An0ther-Strong-One!' }, token: await tokenFor(id) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'acct.errPasswordlessAccount' } });
    expect((await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(id).first())?.password_hash).toBeNull();
  });

  it('a Google-only account can get a password through the emailed reset link', async () => {
    const id = await createUser('google-reset@example.com', { googleId: 'g-reset', password: null });
    const send = vi.spyOn(env.EMAIL_QUEUE, 'send').mockResolvedValue({ metadata: {} } as never);
    const res = await call('/api/v1/auth/password/reset/request', { body: { email: 'google-reset@example.com' } });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();

    const token = await ott.issue(env, ott.PASSWORD_RESET, id, ott.PASSWORD_RESET_TTL);
    const ok = await call('/api/v1/auth/password/reset/confirm', { body: { token, new_password: 'Brand-New-Pass-42' } });
    expect(ok.status).toBe(200);
    await login('google-reset@example.com', 'Brand-New-Pass-42');
  });

  it('change ends other sessions and returns a fresh pair', async () => {
    await createUser('change@example.com');
    const other = await login('change@example.com');
    const mine = await login('change@example.com');
    const wrong = await call('/api/v1/auth/password', {
      body: { old_password: 'wrong-password-1', new_password: 'An0ther-Strong-One' },
      token: mine.access,
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error.fields.old_password).toBeTruthy();
    const res = await call('/api/v1/auth/password', {
      body: { old_password: PASSWORD, new_password: 'An0ther-Strong-One' },
      token: mine.access,
    });
    expect(res.status).toBe(200);
    const body = { ...((await res.json()) as { code: string }), refresh: sessionOf(res).refresh };
    expect(body.code).toBe('acct.passwordUpdated');
    expect((await call('/api/v1/auth/refresh', { body: { refresh: other.refresh } })).status).toBe(401);
    expect((await call('/api/v1/auth/refresh', { body: { refresh: body.refresh } })).status).toBe(200);
  });

  it('reset: generic answer, single-use link, sessions revoked, weak password keeps the link', async () => {
    const id = await createUser('reset@example.com');
    const session = await login('reset@example.com');
    for (const email of ['reset@example.com', 'nobody@example.com']) {
      const res = await call('/api/v1/auth/password/reset/request', { body: { email } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ code: 'acct.passwordResetSent' });
    }
    const token = await ott.issue(env, ott.PASSWORD_RESET, id, ott.PASSWORD_RESET_TTL);
    const weak = await call('/api/v1/auth/password/reset/confirm', { body: { token, new_password: 'short' } });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as any).error.fields.new_password).toContain('acct.errPasswordTooShort');

    const ok = await call('/api/v1/auth/password/reset/confirm', { body: { token, new_password: 'Brand-New-Pass-42' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ code: 'acct.passwordResetSuccess' });
    expect((await call('/api/v1/auth/refresh', { body: { refresh: session.refresh } })).status).toBe(401);
    const reuse = await call('/api/v1/auth/password/reset/confirm', { body: { token, new_password: 'Brand-New-Pass-43' } });
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toEqual({ error: { code: 'auth.errInvalidToken' } });
    await login('reset@example.com', 'Brand-New-Pass-42');
  });

  it('remove needs a linked Google account or a passkey, and refuses staff', async () => {
    await createUser('nogoogle@example.com');
    const a = await login('nogoogle@example.com');
    const r1 = await call('/api/v1/auth/password/remove', { body: { password: PASSWORD }, token: a.access });
    expect(await r1.json()).toEqual({ error: { code: 'auth.errNoOtherSignIn' } });

    await createUser('staffgoogle@example.com', { role: 'staff', googleId: 'g-staff' });
    const s = await login('staffgoogle@example.com');
    const r2 = await call('/api/v1/auth/password/remove', { body: { password: PASSWORD }, token: s.access });
    expect(await r2.json()).toEqual({ error: { code: 'auth.errStaffCannotRemovePassword' } });

    await createUser('linked@example.com', { googleId: 'g-linked' });
    const l = await login('linked@example.com');
    const bad = await call('/api/v1/auth/password/remove', { body: { password: 'wrong-pass-1' }, token: l.access });
    expect(await bad.json()).toEqual({ error: { code: 'auth.errInvalidPassword' } });
    const ok = await call('/api/v1/auth/password/remove', { body: { password: PASSWORD }, token: l.access });
    expect(await ok.json()).toEqual({ code: 'acct.passwordRemoved' });
    const me = (await (await call('/api/v1/auth/me', { token: l.access })).json()) as any;
    expect(me.has_password).toBe(false);
  });

  it('remove also works with a passkey and no Google account', async () => {
    const id = await createUser('keyonly@example.com');
    const k = await login('keyonly@example.com');
    const refused = await call('/api/v1/auth/password/remove', { body: { password: PASSWORD }, token: k.access });
    expect(await refused.json()).toEqual({ error: { code: 'auth.errNoOtherSignIn' } });

    await env.DB.prepare(
      "INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, name, created_at) VALUES ('cred-1', ?, 'pk', 0, 'multiDevice', 1, 'Passkey', '2026-10-17T00:00:00.000Z')",
    )
      .bind(id)
      .run();
    const ok = await call('/api/v1/auth/password/remove', { body: { password: PASSWORD }, token: k.access });
    expect(await ok.json()).toEqual({ code: 'acct.passwordRemoved' });
  });
});

describe('campus email verification', () => {
  it('rejects non-campus addresses, unsupported schools and lists', async () => {
    await createUser('student@example.com');
    const { access } = await login('student@example.com');
    const req = (edu_email: string) => call('/api/v1/auth/verify/request', { body: { edu_email }, token: access });
    expect(await (await req('me@gmail.com')).json()).toEqual({ error: { code: 'acct.errEduEmail' } });
    expect(await (await req('me@gmail.com, b12@ntu.edu.tw')).json()).toEqual({ error: { code: 'acct.errEduEmail' } });
    expect(await (await req('me@unknown.edu.tw')).json()).toEqual({ error: { code: 'acct.errSchoolNotSupported' } });
    const sent = await req('B12345@NTU.edu.tw');
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ code: 'acct.sentVerification' });
    expect((await call('/api/v1/auth/verify/request', { body: { edu_email: 'x@ntu.edu.tw' } })).status).toBe(401);
  });

  it('verifies through the link once, and an address stays with one account', async () => {
    const id = await createUser('verify-flow@example.com');
    const { access } = await login('verify-flow@example.com');
    const token = await ott.issue(env, ott.EDU_VERIFY, id, ott.EDU_VERIFY_TTL, { edu_email: 'r1@ntu.edu.tw' });
    const ok = await call('/api/v1/auth/verify', { body: { token } });
    expect(await ok.json()).toEqual({ code: 'acct.verifySuccess' });
    expect((await call('/api/v1/auth/verify', { body: { token } })).status).toBe(400);

    const me = (await (await call('/api/v1/auth/me?region=TW', { token: access })).json()) as any;
    expect(me.is_verified).toBe(true);
    expect(me.edu_email).toBe('r1@ntu.edu.tw');
    expect(me.regions).toEqual(['TW']);
    expect(me.school_name).toBe('國立臺灣大學'); // region default language

    await createUser('second@example.com');
    const other = await login('second@example.com');
    const taken = await call('/api/v1/auth/verify/request', { body: { edu_email: 'R1@ntu.edu.tw' }, token: other.access });
    expect(await taken.json()).toEqual({ error: { code: 'acct.errEmailTaken' } });

    const unbind = await call('/api/v1/auth/verify/unbind?region=TW', { body: {}, token: access });
    expect(await unbind.json()).toEqual({ code: 'acct.unbindSuccess' });
    const again = await call('/api/v1/auth/verify/unbind?region=TW', { body: {}, token: access });
    expect(await again.json()).toEqual({ error: { code: 'acct.errNotVerified' } });
  });

  it('auto-verifies a campus sign-in email', async () => {
    await createUser('auto@hku.hk');
    const { access } = await login('auto@hku.hk');
    const res = await call('/api/v1/auth/verify/auto', { body: {}, token: access });
    expect(await res.json()).toEqual({ code: 'acct.verifySuccess' });
    const me = (await (await call('/api/v1/auth/me?region=HK', { token: access })).json()) as any;
    expect(me.is_verified).toBe(true);
  });
});

describe('school requests', () => {
  it('creates once, repeats answer 200 with the same row, and validates with i18n keys', async () => {
    await createUser('requester@example.com');
    const { access } = await login('requester@example.com');
    const body = { school_name: 'Example University', school_website: 'https://example.edu.tw', edu_email: ' Me@Example.edu.tw ' };
    const first = await call('/api/v1/auth/school-requests?region=TW', { body, token: access });
    expect(first.status).toBe(201);
    const row = (await first.json()) as any;
    expect(row).toMatchObject({ school_name: 'Example University', edu_email: 'me@example.edu.tw', status: 'pending' });
    const again = await call('/api/v1/auth/school-requests?region=TW', {
      body: { ...body, school_name: 'example university' },
      token: access,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).id).toBe(row.id);

    const badSite = await call('/api/v1/auth/school-requests?region=TW', {
      body: { school_name: 'X Uni', school_website: 'ftp://x.edu' },
      token: access,
    });
    expect(badSite.status).toBe(400);
    expect(((await badSite.json()) as any).error.fields.school_website).toEqual(['acct.errSchoolRequestWebsite']);
    const badName = await call('/api/v1/auth/school-requests?region=TW', {
      body: { school_name: 'X', school_website: 'https://x.edu' },
      token: access,
    });
    expect(((await badName.json()) as any).error.fields.school_name).toEqual(['acct.errSchoolRequestName']);
  });
});

describe('profile', () => {
  it('GET /me/ has the account page blocks; anonymous is 401', async () => {
    expect((await call('/api/v1/auth/me')).status).toBe(401);
    await createUser('profile@example.com');
    const { access } = await login('profile@example.com');
    const me = (await (await call('/api/v1/auth/me?region=TW&include=listings,subscriptions', { token: access })).json()) as any;
    expect(me).toMatchObject({
      email: 'profile@example.com',
      is_verified: false,
      has_password: true,
      is_google_linked: false,
      role: 'user',
      managed_regions: [],
      pending_email: null,
      mySubscriptions: [],
      myListingCounts: { active: 0, reserved: 0, sold: 0, removed: 0, all: 0 },
      myListings: { count: 0, results: [] },
    });
  });

  it('PATCH saves names and starts (never applies) an email change', async () => {
    const id = await createUser('patch@example.com');
    const { access } = await login('patch@example.com');
    const names = await call('/api/v1/auth/me', { method: 'PATCH', body: { first_name: ' Ada ', last_name: 'Lovelace' }, token: access });
    expect(((await names.json()) as any).display_name).toBe('Ada Lovelace');

    const edu = await call('/api/v1/auth/me', { method: 'PATCH', body: { email: 'me@mail.ntu.edu.tw' }, token: access });
    expect(await edu.json()).toEqual({ error: { code: 'acct.errEduEmailChangeNotAllowed' } });

    const noPassword = await call('/api/v1/auth/me', { method: 'PATCH', body: { email: 'New@Example.com' }, token: access });
    expect(((await noPassword.json()) as any).error.fields).toEqual({ current_password: ['acct.errCurrentPasswordRequired'] });
    const wrongPassword = await call('/api/v1/auth/me', {
      method: 'PATCH',
      body: { email: 'New@Example.com', current_password: 'not-it' },
      token: access,
    });
    expect(((await wrongPassword.json()) as any).error.fields).toEqual({ current_password: ['auth.errInvalidPassword'] });
    expect(await ott.pendingEmailChange(env, id)).toBeNull();

    const pending = await call('/api/v1/auth/me', {
      method: 'PATCH',
      body: { email: 'New@Example.com', current_password: PASSWORD },
      token: access,
    });
    expect(await pending.json()).toEqual({ code: 'acct.emailChangePending', pending_email: 'new@example.com' });
    expect((await userRow('patch@example.com'))?.id).toBe(id);
    const me = (await (await call('/api/v1/auth/me', { token: access })).json()) as any;
    expect(me.pending_email).toBe('new@example.com');

    const cancel = await call('/api/v1/auth/email/change/cancel', { body: {}, token: access });
    expect(await cancel.json()).toEqual({ code: 'acct.emailChangeCancelled' });

    const token = await ott.issueEmailChange(env, id, 'moved@example.com');
    // Through the app with a recording queue, so the queued notice can be read back.
    const send = vi.fn(async () => {});
    const confirm = await app.request(
      '/api/v1/auth/email/change/confirm',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
      { ...env, EMAIL_QUEUE: { send } },
    );
    expect(await confirm.json()).toEqual({ code: 'acct.emailChanged' });
    // The address it moved away from is told.
    expect(send).toHaveBeenCalledWith({ type: 'email_changed', user_id: id, to: 'patch@example.com', new_email: 'moved@example.com' });
    expect((await userRow('moved@example.com'))?.id).toBe(id);
    const reuse = await call('/api/v1/auth/email/change/confirm', { body: { token } });
    expect(await reuse.json()).toEqual({ error: { code: 'acct.errEmailChangeTokenInvalid' } });

    const badAvatar = await call('/api/v1/auth/me', { method: 'PATCH', body: { show_avatar: 'yes' }, token: access });
    expect(badAvatar.status).toBe(400);
  });

  it('DELETE /me/ anonymizes the account and ends its sessions', async () => {
    await createUser('leaving@example.com');
    const { access, refresh } = await login('leaving@example.com');
    const res = await call('/api/v1/auth/me', { method: 'DELETE', token: access });
    expect(res.status).toBe(204);
    expect(await userRow('leaving@example.com')).toBeNull();
    expect((await call('/api/v1/auth/refresh', { body: { refresh } })).status).toBe(401);
  });

  it('public profile by id; unknown id is 404', async () => {
    const id = await createUser('public@example.com', { first: '恭煥', last: '周' });
    const res = await call(`/api/v1/auth/users/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ id, display_name: '周恭煥', is_verified: false, avatar_url: '' });
    expect(body.email).toBeUndefined();
    expect((await call(`/api/v1/auth/users/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call('/api/v1/auth/users/1')).status).toBe(404);
  });
});

describe('notification settings, push devices, site language/region', () => {
  it('notifications: defaults, booleans only, known email languages only, extra fields ignored', async () => {
    await createUser('notify@example.com');
    const { access } = await login('notify@example.com');
    const url = '/api/v1/auth/me/notifications';
    expect(await (await call(url, { token: access })).json()).toEqual({
      new_message_email: true,
      push: true,
      email_language: 'auto',
      site_language: '',
    });
    const off = await call(url, { method: 'PATCH', body: { new_message_email: false, role: 'admin' }, token: access });
    expect(((await off.json()) as any).new_message_email).toBe(false);
    expect((await userRow('notify@example.com'))?.role).toBe('user');
    expect((await call(url, { method: 'PATCH', body: { new_message_email: 'sometimes' }, token: access })).status).toBe(400);
    expect((await call(url, { method: 'PATCH', body: { email_language: 'fr' }, token: access })).status).toBe(400);
    const zh = await call(url, { method: 'PATCH', body: { email_language: 'zh-HK' }, token: access });
    expect(((await zh.json()) as any).email_language).toBe('zh-HK');
    await call(url, { method: 'PATCH', body: { site_language: 'en' }, token: access });
    expect((await userRow('notify@example.com'))?.site_language).toBe('');
  });

  it('push devices: idempotent, moves between accounts, removes only your own', async () => {
    const aId = await createUser('push-a@example.com');
    const bId = await createUser('push-b@example.com');
    const a = await login('push-a@example.com');
    const b = await login('push-b@example.com');
    const url = '/api/v1/auth/me/push-devices';
    expect((await call(url, { body: { token: 'tok-1' }, token: a.access })).status).toBe(204);
    expect((await call(url, { body: { token: 'tok-1' }, token: a.access })).status).toBe(204);
    expect((await call(url, { body: { token: '' }, token: a.access })).status).toBe(400);
    expect((await call(url, { body: { token: 'x'.repeat(513) }, token: a.access })).status).toBe(400);

    await call(url, { body: { token: 'tok-1' }, token: b.access });
    const owner = await env.DB.prepare('SELECT user_id FROM push_devices WHERE token = ?').bind('tok-1').first<{ user_id: string }>();
    expect(owner?.user_id).toBe(bId);

    await call(url, { method: 'DELETE', body: { token: 'tok-1' }, token: a.access });
    expect(await env.DB.prepare('SELECT 1 FROM push_devices WHERE token = ?').bind('tok-1').first()).not.toBeNull();
    await call(url, { method: 'DELETE', body: { token: 'tok-1' }, token: b.access });
    expect(await env.DB.prepare('SELECT 1 FROM push_devices WHERE token = ?').bind('tok-1').first()).toBeNull();
    expect(aId).not.toBe(bId);
  });

  it('site language and region', async () => {
    const id = await createUser('site@example.com');
    const { access } = await login('site@example.com');
    expect((await call('/api/v1/auth/me/site-language', { method: 'PUT', body: { language: 'en' }, token: access })).status).toBe(204);
    expect((await call('/api/v1/auth/me/site-language', { method: 'PUT', body: { language: 'fr' }, token: access })).status).toBe(400);
    expect((await call('/api/v1/auth/me/site-region', { method: 'PUT', body: { region: 'tw' }, token: access })).status).toBe(400);
    await env.DB.prepare(
      `INSERT INTO region_verifications (user_id, region_code, school_id, edu_email, verified_at, is_active, created_at)
       VALUES (?, 'TW', 1, 'site@ntu.edu.tw', ?, 1, ?)`,
    )
      .bind(id, new Date().toISOString(), new Date().toISOString())
      .run();
    expect((await call('/api/v1/auth/me/site-region', { method: 'PUT', body: { region: 'tw' }, token: access })).status).toBe(204);
    const me = (await (await call('/api/v1/auth/me?region=TW', { token: access })).json()) as any;
    expect(me.site_language).toBe('en');
    expect(me.site_region).toBe('TW');
  });
});

describe('config', () => {
  it('serves the Google client id and hides FCM until it is set up', async () => {
    const body = (await (await call('/api/v1/auth/config')).json()) as any;
    expect(body.google_client_id).toBe(env.GOOGLE_CLIENT_ID);
    expect(body.fcm).toBeNull();
  });
});

describe('GET /auth/me payload optimization and include parameter', () => {
  it('bare /me returns user data and pending_email without listings or subscriptions', async () => {
    await createUser('bare-me@example.com');
    const { access } = await login('bare-me@example.com');
    const res = await call('/api/v1/auth/me', { token: access });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.email).toBe('bare-me@example.com');
    expect('pending_email' in body).toBe(true);
    expect(body.myListingCounts).toBeUndefined();
    expect(body.myListings).toBeUndefined();
    expect(body.mySubscriptions).toBeUndefined();
  });

  it('include=listings,subscriptions returns listings, counts and subscriptions', async () => {
    await createUser('include-me@example.com');
    const { access } = await login('include-me@example.com');
    const res = await call('/api/v1/auth/me?include=listings,subscriptions&region=TW', { token: access });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.email).toBe('include-me@example.com');
    expect('pending_email' in body).toBe(true);
    expect(body.myListingCounts).toBeDefined();
    expect(body.myListingCounts.all).toBe(0);
    expect(body.myListings).toBeDefined();
    expect(Array.isArray(body.myListings.results)).toBe(true);
    expect(body.mySubscriptions).toBeDefined();
    expect(Array.isArray(body.mySubscriptions)).toBe(true);
  });
});
