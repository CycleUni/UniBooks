import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { buildEmail, chatEmailPreview, maskEmail } from '../../src/queues/email';
import { formatMeetupTime } from '../../src/lib/time';
import { passwordProblems } from '../../src/services/accounts/passwords';
import { displayName } from '../../src/services/accounts/users';
import { emailLanguageFor, normalizeLanguage, pickLanguage } from '../../src/services/accounts/i18n';
import { call, createUser, seedReference } from './helpers';

const BASE = 'https://unibooks.app'; // lib/origin.ts default (no origin recorded in tests)

beforeAll(async () => {
  await seedReference();
});

describe('helpers', () => {
  it('password validators', () => {
    expect(passwordProblems('Str0ng-Pass-Phrase!')).toEqual([]);
    expect(passwordProblems('12345678')).toContain('acct.errPasswordNumeric');
    expect(passwordProblems('password')).toContain('acct.errPasswordTooCommon');
    expect(passwordProblems('short1')).toEqual(['acct.errPasswordTooShort']);
    expect(passwordProblems('janedoe123', { email: 'janedoe123@example.com' })).toContain('acct.errPasswordTooSimilar');
  });

  it('display names and languages', () => {
    expect(displayName('恭煥', '周')).toBe('周恭煥');
    expect(displayName('Ada', 'Lovelace')).toBe('Ada Lovelace');
    expect(normalizeLanguage('zh-hant-hk')).toBe('zh-HK');
    expect(emailLanguageFor({ emailLanguage: 'auto', siteLanguage: 'zh-HK' }, 'zh-TW')).toBe('zh-HK');
    expect(emailLanguageFor({ emailLanguage: 'en', siteLanguage: 'zh-HK' }, 'zh-TW')).toBe('en');
    expect(emailLanguageFor({ emailLanguage: 'auto', siteLanguage: '' }, 'zh-TW')).toBe('zh-TW');
  });

  it('requested languages settle against the region', () => {
    expect(pickLanguage('', 'zh-TW', ['zh-TW', 'en'])).toBe('zh-TW');
    expect(pickLanguage('en-US', 'zh-TW', ['zh-TW', 'en'])).toBe('en');
    expect(pickLanguage('fr', 'zh-TW', ['zh-TW', 'en'])).toBe('zh-TW');
    expect(pickLanguage('fr', null, null)).toBe('fr');
  });

  it('chat preview rules and meetup time', () => {
    expect(chatEmailPreview('[SYSTEM:order.notify.delivered]')).toBeNull();
    expect(chatEmailPreview(' a\n\n b ')).toBe('a b');
    expect(chatEmailPreview('x'.repeat(200))).toBe('x'.repeat(120) + '…');
    expect(formatMeetupTime('2026-01-01T10:30:00Z', 'Asia/Taipei')).toBe('2026-01-01 18:30');
  });
});

describe('emails', () => {
  it('account link: request language, frontend link', async () => {
    const mail = await buildEmail(
      {
        type: 'account_link',
        kind: 'passwordReset',
        user_id: 'u',
        to: 'a@example.com',
        name: '',
        lang: 'en',
        path: '/forgot-password?token=abc',
      },
      env,
    );
    expect(mail?.text).toContain(BASE + '/forgot-password?token=abc');
    expect(mail?.subject).toBe('UniBooks Password Reset');
  });

  it("email changed: goes to the old address in the user's language, new address masked", async () => {
    const id = await createUser('moved-to@example.com');
    await env.DB.prepare("UPDATE users SET email_language = 'zh-HK' WHERE id = ?").bind(id).run();
    const mail = await buildEmail({ type: 'email_changed', user_id: id, to: 'old@example.com', new_email: 'moved-to@example.com' }, env);
    expect(mail?.to).toBe('old@example.com');
    expect(mail?.subject).toBe('UniBooks：你嘅登入電郵已經更改');
    expect(mail?.text).toContain('m***@example.com');
    expect(mail?.text).not.toContain('moved-to@example.com');
    expect(mail?.text).toContain(BASE + '/account/settings');
    expect(maskEmail('a@b.c')).toBe('a***@b.c');
    expect(maskEmail('nope')).toBe('***');
  });

  it('chat notification: escaped, region-prefixed link, settings link, recipient language, opt-out', async () => {
    const seller = await createUser('seller-mail@example.com', { first: '<script>', last: 'x"' });
    const buyer = await createUser('buyer-mail@example.com');
    await env.DB.prepare("UPDATE users SET email_language = 'zh-TW' WHERE id = ?").bind(buyer).run();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO conversations (id, room_id, region_code, buyer_id, seller_id, book_title, updated_at, created_at)
       VALUES ('conv-1', 'room-1', 'TW', ?, ?, '<b>Book</b>', ?, ?)`,
    )
      .bind(buyer, seller, now, now)
      .run();
    const msg = {
      type: 'offline_chat_notification' as const,
      recipient_id: buyer,
      room_id: 'room-1',
      sender_id: seller,
      preview: 'hi <img src=x onerror=alert(1)>',
    };
    const mail = await buildEmail(msg, env);
    expect(mail?.to).toBe('buyer-mail@example.com');
    expect(mail?.html).not.toContain('<script>');
    expect(mail?.html).not.toContain('<img');
    expect(mail?.html).toContain('&lt;script&gt;');
    expect(mail?.text).toContain(BASE + '/tw/messages?chat=conv-1');
    expect(mail?.text).toContain(BASE + '/account/notifications');
    expect(mail?.subject).toContain('UniBooks：');

    await env.DB.prepare('UPDATE users SET notify_new_message_email = 0 WHERE id = ?').bind(buyer).run();
    expect(await buildEmail(msg, env)).toBeNull();
  });

  it('waitlist: one email listing every book, unsubscribe link', async () => {
    const id = await createUser('wait@example.com');
    const mail = await buildEmail(
      {
        type: 'waitlist_notification',
        user_id: id,
        email: 'wait@example.com',
        book_title: 'A',
        listing_count: 1,
        region: 'TW',
        books: [
          { title: 'A & B', isbn13: '9780000000001', region: 'TW' },
          { title: 'C', isbn13: null, region: 'HK' },
        ],
      },
      env,
    );
    expect(mail?.text).toContain(BASE + '/tw/book?isbn=9780000000001');
    expect(mail?.text).toContain(`- C: ${BASE}/hk`);
    expect(mail?.text).toContain(BASE + '/account/subscriptions');
    expect(mail?.html).toContain('A &amp; B');
  });

  it('a banned user is not emailed notifications', async () => {
    const id = await createUser('banned-mail@example.com');
    await env.DB.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(id).run();
    const reminder = {
      type: 'meetup_reminder' as const,
      user_id: id,
      email: 'banned-mail@example.com',
      order_id: 'o1',
      book_title: 'B',
      meetup_time: '2026-01-01T10:30:00Z',
      meetup_location: '',
    };
    expect(await buildEmail(reminder, env)).toBeNull();
    const waitlist = { type: 'waitlist_notification' as const, user_id: id, email: '', book_title: 'B', listing_count: 1, region: 'TW' };
    expect(await buildEmail(waitlist, env)).toBeNull();
  });

  it('meetup reminder in the given timezone', async () => {
    const id = await createUser('meet@example.com');
    const mail = await buildEmail(
      {
        type: 'meetup_reminder',
        user_id: id,
        email: 'meet@example.com',
        order_id: 'o1',
        book_title: 'Calculus',
        meetup_time: '2026-01-01T10:30:00Z',
        meetup_location: 'Library',
        region: 'HK',
        timezone: 'Asia/Hong_Kong',
      },
      env,
    );
    expect(mail?.text).toContain('2026-01-01 18:30');
    expect(mail?.text).toContain(BASE + '/account/orders');
  });
});

describe('core', () => {
  it('healthz, regions, geo, metadata', async () => {
    const health = await call('/api/v1/core/healthz');
    const hb = (await health.json()) as any;
    expect(hb.checks.database).toBe('ok');
    expect(hb.checks.cache).toBe('ok');

    const regions = (await (await call('/api/v1/core/regions?lang=zh-TW')).json()) as any[];
    expect(regions.map((r) => r.code)).toEqual(['TW', 'HK']);
    expect(regions[0]).toMatchObject({
      localized_name: '台灣',
      currency: { code: 'TWD', symbol: 'NT$', decimal_places: 0, symbol_position: 'prefix' },
      edu_email_suffix: ['.edu.tw'],
    });

    const geo = await call('/api/v1/core/geo', { headers: { 'CF-IPCountry': 'tw' } });
    expect(await geo.json()).toEqual({ region: 'TW' });
    expect(geo.headers.get('Cache-Control')).toBe('no-store');
    expect(await (await call('/api/v1/core/geo', { headers: { 'CF-IPCountry': 'XX' } })).json()).toEqual({ region: null });

    const meta = (await (await call('/api/v1/core/metadata?region=TW&lang=zh-TW')).json()) as any;
    expect(meta.region).toEqual({ code: 'TW', currency: 'TWD' });
    expect(meta.schools[0]).toMatchObject({ code: 'NTU', display_name: '國立臺灣大學', email_domain: 'ntu.edu.tw' });
    expect(meta.schools[0].names).toEqual(['National Taiwan University', '國立臺灣大學']);
    expect(meta.waitlist).toEqual([]);
    const unknown = (await (await call('/api/v1/core/metadata?region=TW&school=NOPE')).json()) as any;
    expect(unknown.waitlist).toEqual([]);
  });
});
