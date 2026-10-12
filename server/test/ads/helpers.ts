import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { vi } from 'vitest';
import type { AppEnv, Env } from '../../src/env';
import { errorHandler } from '../../src/middleware/error';
import { adminRoutes } from '../../src/routes/admin';
import { promotionRoutes } from '../../src/routes/promotions';
import { signToken } from '../../src/lib/jwt';
import { createUser, seedReference } from '../accounts/helpers';

export const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/api/v1/admin/', adminRoutes);
app.route('/api/v1/promotions/', promotionRoutes);

/** A stand-in for the AD_EVENTS Analytics Engine binding. */
export function stubAdEvents() {
  return { writeDataPoint: vi.fn() };
}

export interface CallInit {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  env?: Partial<Env>;
}

export async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('X-Region')) headers.set('X-Region', 'TW');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const req = new Request(`http://x${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return app.fetch(req, { ...env, ...(init.env ?? {}) });
}

export const tokenFor = (userId: string) => signToken('access', { user_id: userId }, env.JWT_SIGNING_KEY);

export async function staff(email: string, opts: { superuser?: boolean; regions?: string[] } = {}) {
  const id = await createUser(email, { role: opts.superuser ? 'admin' : 'staff' });
  for (const r of opts.regions ?? []) {
    await env.DB.prepare('INSERT INTO staff_managed_regions (user_id, region_code) VALUES (?, ?)').bind(id, r).run();
  }
  return { id, token: await tokenFor(id) };
}

export { seedReference };

const DAY = 86_400_000;
export const past = (days = 1) => new Date(Date.now() - days * DAY).toISOString();
export const future = (days = 30) => new Date(Date.now() + days * DAY).toISOString();

/** Insert an advertiser straight into the ads DB. */
export async function advertiser(
  opts: { name?: string; allRegions?: boolean; regions?: string[]; active?: boolean } = {},
): Promise<number> {
  const now = new Date().toISOString();
  const row = await env.DB_ADS.prepare(
    `INSERT INTO advertisers (company_name, contact_email, all_regions, all_schools, is_active, created_at, updated_at)
     VALUES (?, 'ads@example.com', ?, 1, ?, ?, ?) RETURNING id`,
  )
    .bind(opts.name ?? 'Acme', opts.allRegions ? 1 : 0, opts.active === false ? 0 : 1, now, now)
    .first<{ id: number }>();
  for (const r of opts.regions ?? []) {
    await env.DB_ADS.prepare('INSERT INTO advertiser_regions (advertiser_id, region_code) VALUES (?, ?)').bind(row!.id, r).run();
  }
  return row!.id;
}

/** Insert an ad straight into the ads DB (live by default). */
export async function ad(
  advertiserId: number,
  opts: { title?: string; active?: boolean; start?: string; end?: string } = {},
): Promise<number> {
  const now = new Date().toISOString();
  const row = await env.DB_ADS.prepare(
    `INSERT INTO ads (advertiser_id, title, image_url, target_url, position, labels, start_date, end_date, is_active, created_at, updated_at)
     VALUES (?, ?, 'https://cdn.example.com/a.png', 'https://shop.example.com/', 'home_banner', '["new"]', ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(advertiserId, opts.title ?? 'Sale', opts.start ?? past(), opts.end ?? future(), opts.active === false ? 0 : 1, now, now)
    .first<{ id: number }>();
  return row!.id;
}
