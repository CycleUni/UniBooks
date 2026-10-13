import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { auditEvents, type Database } from '../../db';

/**
 * Audit events (user, kind, meta). Stored as
 * actor_id / action / details (JSON) plus a target for indexed lookups.
 */
export interface AuditArgs {
  actorId: string | null;
  kind: string;
  meta: Record<string, unknown>;
  targetType: string;
  targetId: string | number;
}

/** `{field: {before, after}}` for each key of `set` whose value differs from the same key of `before`. */
export function changedFields(before: object, set: object): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  const old = before as Record<string, unknown>;
  for (const [k, v] of Object.entries(set)) {
    if (JSON.stringify(old[k] ?? null) !== JSON.stringify(v ?? null)) out[k] = { before: old[k] ?? null, after: v ?? null };
  }
  return out;
}

/** The insert, un-awaited, so callers can put it in a db.batch([...]). */
export function auditInsert(db: Database, a: AuditArgs, c?: Context<AppEnv>) {
  return db.insert(auditEvents).values({
    actorId: a.actorId,
    action: a.kind,
    targetType: a.targetType,
    targetId: String(a.targetId),
    details: JSON.stringify(a.meta),
    ipAddress: c?.req.header('CF-Connecting-IP') ?? null,
    userAgent: c?.req.header('User-Agent')?.slice(0, 255) ?? null,
    createdAt: new Date().toISOString(),
  });
}

export async function writeAudit(db: Database, a: AuditArgs, c?: Context<AppEnv>): Promise<void> {
  await auditInsert(db, a, c);
}
