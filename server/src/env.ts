import type { Region } from './db';

/**
 * Bindings and variables of the single UniBooks Worker (wrangler.jsonc).
 */
export interface Env {
  // Bindings
  DB: D1Database;
  /** Advertisers and ads (kept apart from marketplace data). */
  DB_ADS: D1Database;
  /** Ad impression/click events (Workers Analytics Engine). */
  AD_EVENTS?: AnalyticsEngineDataset;
  /** The ISBNnet resolver Worker (service binding); falls back to ISBNNET_RESOLVER_URL. */
  ISBNNET?: Fetcher;
  CHAT_ROOM: DurableObjectNamespace;
  USER_HUB: DurableObjectNamespace;
  ORDER_LOCK: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  R2: R2Bucket;
  KV: KVNamespace;
  EMAIL_QUEUE: Queue;
  PUSH_QUEUE: Queue;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc / .dev.vars)
  ENVIRONMENT: string; // 'production' | 'development' | 'test'
  DEFAULT_REGION: string;
  R2_PUBLIC_URL?: string;
  ALLOWED_IMAGE_HOSTS?: string;
  DEFAULT_FROM_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Only when the ISBNNET service binding is unavailable (e.g. local dev). */
  ISBNNET_RESOLVER_URL?: string;
  /** Account id for the Analytics Engine SQL API (admin ad statistics). */
  CF_ACCOUNT_ID?: string;

  // Secrets (`wrangler secret put`)
  JWT_SIGNING_KEY: string;
  CHAT_JWT_SECRET: string;
  GOOGLE_BOOKS_API_KEY?: string;
  MAILJET_API_KEY?: string;
  MAILJET_SECRET_KEY?: string;
  /** '1' = Mailjet SandboxMode: validate messages without delivering them. */
  MAILJET_SANDBOX?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_PROJECT_ID?: string;
  // Firebase web-push config handed to the app by /api/v1/auth/config/ (public values).
  FCM_WEB_API_KEY?: string;
  FCM_WEB_APP_ID?: string;
  FCM_MESSAGING_SENDER_ID?: string;
  FCM_VAPID_KEY?: string;
  SENTRY_DSN?: string;
  ISBNNET_RESOLVER_SECRET?: string;
  /** API token with Account Analytics:Read, for the Analytics Engine SQL API. */
  CF_ANALYTICS_TOKEN?: string;
}

/** The signed-in user, as loaded from D1 by authMiddleware on each request. */
export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'staff' | 'admin';
  isStaff: boolean;
  isSuperuser: boolean;
}

export interface Variables {
  user?: AuthUser;
  userId?: string;
  /** Set by lib/region getRegion(); read through that, not directly. */
  region?: string;
  regionObj?: Region | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};

export const isDev = (env: Env) => env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
