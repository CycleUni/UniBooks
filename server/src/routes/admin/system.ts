import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { requireAdmin } from '../../middleware/auth';
import { platformRateLimit } from '../../middleware/rateLimit';
import { systemHealth } from '../../services/health';

/**
 * /api/v1/admin/system/*: platform status for superusers. Each load makes one
 * live call to Google Books (from the shared budget), Open Library and the
 * ISBNnet resolver, so it is capped per user.
 */
export const systemRoutes = new Hono<AppEnv>();

systemRoutes.use('/system/*', requireAdmin());

systemRoutes.get('/system/health', platformRateLimit('admin-health', '30/min'), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await systemHealth(c.env));
});
