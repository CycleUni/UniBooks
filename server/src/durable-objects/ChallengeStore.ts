import { DurableObject } from 'cloudflare:workers';

export interface ChallengeRecord {
  challenge: string;
  type: 'reg' | 'auth' | 'mfa';
  userId?: string;
}

interface StoredChallenge {
  record: ChallengeRecord;
  expiresAt: number;
}

/**
 * Single-use WebAuthn challenge store, one instance per challenge id.
 * A Durable Object serialises calls, so take() atomically consumes and deletes
 * the record — unlike KV read-then-delete, which is vulnerable to replay races
 * and bounded by KV write limits.
 */
export class ChallengeStore extends DurableObject {
  async put(record: ChallengeRecord, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    await this.ctx.storage.put<StoredChallenge>('c', { record, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  /** Atomically returns the record (or null if absent/expired) and deletes it. */
  async take(): Promise<ChallengeRecord | null> {
    const stored = await this.ctx.storage.get<StoredChallenge>('c');
    if (!stored) return null;
    await this.ctx.storage.deleteAll();
    if (Date.now() >= stored.expiresAt) return null;
    return stored.record;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
