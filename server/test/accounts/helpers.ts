import { env, exports } from 'cloudflare:workers';
import { hashPassword } from '../../src/lib/crypto';

export const PASSWORD = 'Str0ng-Pass-Phrase!';

let passwordHash: string | null = null;

export async function seedReference(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO currencies (code, symbol, decimal_places, symbol_position) VALUES ('TWD', 'NT$', 0, 'prefix')"),
    env.DB.prepare("INSERT OR IGNORE INTO currencies (code, symbol, decimal_places, symbol_position) VALUES ('HKD', 'HK$', 2, 'prefix')"),
    env.DB.prepare("INSERT OR IGNORE INTO languages (code, name) VALUES ('zh-TW', 'Chinese (Taiwan)')"),
    env.DB.prepare("INSERT OR IGNORE INTO languages (code, name) VALUES ('zh-HK', 'Chinese (Hong Kong)')"),
    env.DB.prepare("INSERT OR IGNORE INTO languages (code, name) VALUES ('en', 'English')"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO regions (code, name, default_currency, default_language, timezone, translations, languages, search_engines, edu_email_suffix, sort_order, is_active, created_at)
       VALUES ('TW', 'Taiwan', 'TWD', 'zh-TW', 'Asia/Taipei', '{"zh-TW":{"name":"台灣"}}', '["zh-TW","en"]', '["googlebooks"]', '[".edu.tw"]', 0, 1, ?)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO regions (code, name, default_currency, default_language, timezone, translations, languages, search_engines, edu_email_suffix, sort_order, is_active, created_at)
       VALUES ('HK', 'Hong Kong', 'HKD', 'zh-HK', 'Asia/Hong_Kong', '{}', '["zh-HK","en"]', '[]', '[".edu.hk"]', 20, 1, ?)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO schools (id, region_code, code, name, email_domain, translations, is_active, created_at)
       VALUES (1, 'TW', 'NTU', 'National Taiwan University', 'ntu.edu.tw', '{"zh-TW":{"name":"國立臺灣大學"}}', 1, ?)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO schools (id, region_code, code, name, email_domain, translations, is_active, created_at)
       VALUES (2, 'HK', 'HKU', 'The University of Hong Kong', 'hku.hk', '{}', 1, ?)`,
    ).bind(now),
  ]);
}

export async function createUser(
  email: string,
  opts: { active?: boolean; role?: string; googleId?: string | null; password?: string | null; first?: string; last?: string } = {},
): Promise<string> {
  passwordHash ??= await hashPassword(PASSWORD);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const hash = opts.password === null ? null : opts.password ? await hashPassword(opts.password) : passwordHash;
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, first_name, last_name, password_hash, role, google_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      email,
      `${opts.first ?? 'Test'} ${opts.last ?? 'User'}`,
      opts.first ?? 'Test',
      opts.last ?? 'User',
      hash,
      opts.role ?? 'user',
      opts.googleId ?? null,
      opts.active === false ? 0 : 1,
      now,
      now,
    )
    .run();
  return id;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

export async function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
  return worker.fetch(
    new Request(`http://x${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

/** The access/refresh pair a response set as session cookies ('' when absent). */
export function sessionOf(res: Response): { access: string; refresh: string } {
  const jar = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), decodeURIComponent(pair.slice(i + 1).trim()));
  }
  return { access: jar.get('__Host-ub_at') ?? '', refresh: jar.get('__Secure-ub_rt') ?? '' };
}

export async function login(email: string, password = PASSWORD): Promise<{ access: string; refresh: string }> {
  const res = await call('/api/v1/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return sessionOf(res);
}
