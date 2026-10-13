import type { Env } from '../env';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/** Whether Turnstile is configured: the secret, and a site key the client can render with. */
export const turnstileEnabled = (env: Env) => !!env.TURNSTILE_SECRET_KEY && !!env.TURNSTILE_SITE_KEY;

/**
 * Check a Turnstile response token with Cloudflare (siteverify). False for
 * a missing, invalid, expired or reused token, and when the check itself
 * fails: the caller asks for a new challenge rather than letting it pass.
 */
export async function verifyTurnstile(env: Env, token: unknown, remoteIp?: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY || typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (e) {
    console.warn('[turnstile] siteverify failed', e);
    return false;
  }
}
