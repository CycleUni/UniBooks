import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { authMiddleware, requireStaff } from '../../middleware/auth';
import { adRoutes } from './ads';
import { regionRoutes } from './regions';
import { schoolRoutes } from './schools';
import { categoryRoutes } from './categories';
import { userRoutes } from './users';
import { listingRoutes } from './listings';
import { orderRoutes } from './orders';
import { chatReportRoutes } from './chatReports';
import { bookRoutes } from './books';
import { statsRoutes } from './stats';

/**
 * /api/v1/admin/*. Every endpoint needs a staff
 * user; region scoping (the regions a staff user manages) is applied
 * per route through services/admin/scope.ts, admin-only routes add
 * requireAdmin().
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', authMiddleware(), requireStaff());

adminRoutes.route('/', regionRoutes);
adminRoutes.route('/', statsRoutes);
adminRoutes.route('/', bookRoutes);
adminRoutes.route('/', userRoutes);
adminRoutes.route('/', listingRoutes);
adminRoutes.route('/', orderRoutes);
adminRoutes.route('/', schoolRoutes);
adminRoutes.route('/', categoryRoutes);
adminRoutes.route('/', chatReportRoutes);
adminRoutes.route('/', adRoutes);
