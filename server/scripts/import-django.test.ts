// node --experimental-strip-types --test scripts/import-django.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { convert, uuidv5, userUuid, bookUuid, displayName, NAMESPACE, type DumpRow } from './import-django.ts';

const NOW = '2026-01-01T00:00:00.000Z';

export const fixture: DumpRow[] = [
  { model: 'core.currency', pk: 'TWD', fields: { symbol: 'NT$', decimal_places: 0, symbol_position: 'prefix', is_active: true } },
  {
    model: 'core.language',
    pk: 'zh-TW',
    fields: { name: 'Traditional Chinese (Taiwan)', native_name: '繁體中文（台灣）', is_active: true, sort_order: 20 },
  },
  { model: 'core.language', pk: 'en', fields: { name: 'English', native_name: 'English', is_active: true, sort_order: 10 } },
  {
    model: 'core.region',
    pk: 'TW',
    fields: {
      name: 'Taiwan',
      translations: { 'zh-TW': { name: '台灣' } },
      currency: 'TWD',
      default_language: 'zh-TW',
      languages: ['zh-TW', 'en'],
      timezone: 'Asia/Taipei',
      search_engines: ['googlebooks'],
      edu_email_suffix: ['.edu.tw'],
      is_active: true,
      sort_order: 10,
    },
  },
  {
    model: 'accounts.school',
    pk: 1,
    fields: {
      email_domain: 'ntu.edu.tw',
      name: 'National Taiwan University',
      translations: { 'zh-TW': { name: '國立台灣大學' } },
      region: 'TW',
      city: null,
      code: 'NTU',
    },
  },
  {
    model: 'core.category',
    pk: 5,
    fields: {
      region: 'TW',
      slug: 'management',
      title: 'College of Management',
      description: '',
      translations: {},
      sort_order: 1,
      is_active: true,
    },
  },
  {
    model: 'accounts.user',
    pk: 1,
    fields: {
      password: 'pbkdf2_sha256$secret',
      last_login: '2025-05-01T10:00:00.123Z',
      is_superuser: false,
      email: "O'Brien@Example.com",
      first_name: "Pat'rick",
      last_name: "O'Brien",
      avatar_url: null,
      show_avatar: true,
      is_active: true,
      is_staff: false,
      created_at: '2024-01-02T03:04:05.678Z',
      notify_new_message_email: true,
      notify_push: false,
      email_language: 'auto',
      site_language: 'zh-TW',
      site_region: 'TW',
      deleted_at: null,
      managed_regions: [],
    },
  },
  {
    model: 'accounts.user',
    pk: 2,
    fields: {
      password: 'x',
      last_login: null,
      is_superuser: false,
      email: 'staff@example.com',
      first_name: '小明',
      last_name: '王',
      avatar_url: 'https://x/a.png',
      show_avatar: false,
      is_active: true,
      is_staff: true,
      created_at: '2024-02-01T00:00:00Z',
      notify_new_message_email: true,
      notify_push: true,
      email_language: 'zh-TW',
      site_language: '',
      site_region: '',
      deleted_at: null,
      managed_regions: ['TW'],
    },
  },
  {
    model: 'accounts.regionverification',
    pk: 1,
    fields: {
      user: 1,
      region: 'TW',
      school: 1,
      edu_email: 'B01@NTU.edu.tw',
      is_manual_verification: false,
      verified_at: '2024-03-01T00:00:00Z',
      last_reverified_at: null,
      is_active: true,
      created_at: '2024-03-01T00:00:00Z',
    },
  },
  {
    model: 'catalog.book',
    pk: 10,
    fields: {
      region: 'TW',
      isbn13: '9780000000001',
      title: "Don't Panic\nLine two",
      authors: 'A',
      publisher: '',
      published_date: '2020',
      cover_url: '',
      source: 'google_api',
      created_at: '2024-01-05T00:00:00Z',
      reviewed_at: null,
      reviewed_by: null,
    },
  },
  {
    model: 'catalog.book',
    pk: 11,
    fields: {
      region: 'TW',
      isbn13: null,
      title: 'Manual Book',
      authors: '',
      publisher: '',
      published_date: '',
      cover_url: '',
      source: 'manual',
      created_at: '2024-01-06T00:00:00Z',
      reviewed_at: '2024-01-07T00:00:00Z',
      reviewed_by: 2,
    },
  },
  {
    model: 'listings.listing',
    pk: '11111111-1111-4111-8111-111111111111',
    fields: {
      region: 'TW',
      currency: 'TWD',
      book: 10,
      seller: 1,
      school: 1,
      price: 300,
      condition: 'noted',
      private_note: "it's mine",
      description: 'He said "hi"; DROP TABLE users;--',
      photos: ['https://cdn.example/listings/a.jpg'],
      category: 5,
      status: 'active',
      admin_locked: false,
      admin_lock_reason: '',
      locked_by: null,
      locked_at: null,
      course_name: 'Econ',
      professor_name: '',
      created_at: '2024-04-01T00:00:00Z',
      updated_at: '2024-04-02T00:00:00Z',
    },
  },
  {
    model: 'listings.listing',
    pk: '22222222-2222-4222-8222-222222222222',
    fields: {
      region: 'TW',
      currency: 'TWD',
      book: 11,
      seller: 2,
      school: null,
      price: 100,
      condition: 'new',
      private_note: '',
      description: '',
      photos: [],
      category: null,
      status: 'sold',
      admin_locked: true,
      admin_lock_reason: 'spam',
      locked_by: 2,
      locked_at: '2024-05-01T00:00:00Z',
      course_name: '',
      professor_name: '',
      created_at: '2024-04-03T00:00:00Z',
      updated_at: '2024-04-04T00:00:00Z',
    },
  },
  // dangling: seller 999 does not exist
  {
    model: 'listings.listing',
    pk: '33333333-3333-4333-8333-333333333333',
    fields: {
      region: 'TW',
      currency: 'TWD',
      book: 10,
      seller: 999,
      school: null,
      price: 1,
      condition: 'new',
      private_note: '',
      description: '',
      photos: [],
      category: null,
      status: 'active',
      admin_locked: false,
      admin_lock_reason: '',
      locked_by: null,
      locked_at: null,
      course_name: '',
      professor_name: '',
      created_at: '2024-04-03T00:00:00Z',
      updated_at: '2024-04-04T00:00:00Z',
    },
  },
];

const run = () => convert(fixture, NOW);

test('uuidv5 matches the RFC 4122 reference vector', () => {
  // Well-known vector: uuid5(NAMESPACE_DNS, "python.org")
  assert.equal(uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
});

test('ids are deterministic and stable across runs', () => {
  assert.equal(userUuid(1), userUuid(1));
  assert.notEqual(userUuid(1), userUuid(2));
  assert.notEqual(userUuid(1), bookUuid(1));
  assert.match(userUuid(1), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(run().sql, run().sql);
  assert.ok(run().sql.includes(userUuid(1)));
  assert.ok(NAMESPACE.length === 36);
});

test('quotes are escaped and statements stay on one line', () => {
  const { sql } = run();
  assert.ok(sql.includes("'o''brien@example.com'"), 'email lowercased and escaped');
  assert.ok(sql.includes("'Pat''rick'"));
  assert.ok(sql.includes("'it''s mine'"));
  assert.ok(sql.includes(`'He said "hi"; DROP TABLE users;--'`));
  assert.ok(sql.includes("'Don''t Panic' || char(10) || 'Line two'"), 'newline encoded');
  for (const line of sql.trim().split('\n')) assert.ok(line.startsWith('--') || line.endsWith(';'), line);
});

test('users: NULL password and google_id, roles, display names', () => {
  const { sql } = run();
  const lines = sql.split('\n').filter((l) => l.startsWith('INSERT OR IGNORE INTO users '));
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(l.includes(', NULL, '), 'has NULLs');
    assert.ok(!l.includes('pbkdf2') && !l.includes('secret'));
    const cols = l.slice(l.indexOf('(') + 1, l.indexOf(')')).split(', ');
    assert.equal(cols[5], 'password_hash');
    assert.equal(cols[9], 'google_id');
  }
  // 'Pat''rick', 'O''Brien', NULL (password_hash), NULL (avatar_url)
  assert.ok(lines[0].includes("'Pat''rick', 'O''Brien', NULL, NULL, 1, 'user', NULL, 1, 0,"));
  assert.ok(lines[0].includes("'user'") && lines[1].includes("'staff'"));
  assert.equal(displayName('小明', '王'), '王小明');
  assert.equal(displayName('Ann', 'Lee'), 'Ann Lee');
  assert.ok(lines[1].includes("'王小明'"));
  assert.ok(lines[0].includes('2025-05-01T10:00:00.123Z') && lines[0].includes('2024-01-02T03:04:05.678Z'));
  assert.ok(
    sql.includes(
      "INSERT OR IGNORE INTO staff_managed_regions (user_id, region_code) SELECT id, 'TW' FROM users WHERE email = 'staff@example.com';",
    ),
  );
});

test('dangling listing is skipped and counted', () => {
  const { sql, stats } = run();
  assert.ok(!sql.includes('33333333-3333-4333-8333-333333333333'));
  assert.ok(sql.includes('11111111-1111-4111-8111-111111111111'));
  assert.ok(sql.includes('22222222-2222-4222-8222-222222222222'));
  assert.deepEqual(stats.listings, { in: 3, out: 2, skipped: { 'missing seller': 1 } });
  assert.equal(stats.users.out, 2);
  assert.equal(stats.books.out, 2);
});

test('statements are ordered by foreign key dependency', () => {
  const { sql } = run();
  const first = (t: string) => sql.indexOf(`INTO ${t} `);
  const order = [
    'currencies',
    'languages',
    'regions',
    'schools',
    'categories',
    'users',
    'staff_managed_regions',
    'region_verifications',
    'books',
    'listings',
  ];
  const idx = order.map(first);
  assert.ok(
    idx.every((i) => i >= 0),
    JSON.stringify(idx),
  );
  assert.deepEqual(
    [...idx].sort((a, b) => a - b),
    idx,
  );
});

test('region languages M2M and JSON columns map to JSON text', () => {
  const { sql } = run();
  assert.ok(sql.includes(`'["zh-TW","en"]'`));
  assert.ok(sql.includes(`'["https://cdn.example/listings/a.jpg"]'`));
  assert.ok(sql.includes(`'[".edu.tw"]'`));
});

test('verification email lowercased; school/category resolved by natural key', () => {
  const { sql } = run();
  assert.ok(sql.includes("'b01@ntu.edu.tw'"));
  assert.ok(sql.includes("(SELECT id FROM schools WHERE region_code = 'TW' AND code = 'NTU')"));
  assert.ok(sql.includes("(SELECT id FROM categories WHERE region_code = 'TW' AND slug = 'management')"));
});

// Writes the generated SQL for the D1 apply check when FIXTURE_SQL_OUT is set.
if (process.env.FIXTURE_SQL_OUT) writeFileSync(process.env.FIXTURE_SQL_OUT, run().sql);
