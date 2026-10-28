import type { SecretSource } from './jwt';

/**
 * The member pass: a short-lived QR code that proves who its holder is, shown
 * on the account page for any on-site check. Nothing about it is stored.
 *
 *   <user id>.<time step>.<first 16 bytes of HMAC-SHA256("<user id>:<time step>"), hex>
 *
 * A time step is MEMBER_TOKEN_STEP_SECONDS long; a verifier should accept the
 * current step and its neighbours, so a code lives about a minute and a half.
 * The HMAC key is HKDF(SECRET_KEY, info "unibooks/member-token"), apart from
 * the JWT keys, so a pass can never stand in for a session. Verifiers derive
 * the same key: changing the format or the info string breaks them.
 */
export const MEMBER_TOKEN_STEP_SECONDS = 30;

const MIN_SECRET_LENGTH = 32;
const SIGNATURE_BYTES = 16;

/** Derived key per secret, kept for the isolate's life: HKDF runs once. */
const derived = new Map<string, Promise<CryptoKey>>();

function key(source: SecretSource): Promise<CryptoKey> {
  const secret = source.SECRET_KEY;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SECRET_KEY missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  let k = derived.get(secret);
  if (!k) {
    const enc = new TextEncoder();
    k = crypto.subtle
      .importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((master) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('unibooks/member-token') },
          master,
          { name: 'HMAC', hash: 'SHA-256', length: 256 },
          false,
          ['sign'],
        ),
      );
    derived.set(secret, k);
  }
  return k;
}

export interface MemberToken {
  token: string;
  step_seconds: number;
  /** Until the step ends, measured on this server: the client's clock may be off. */
  expires_in_ms: number;
}

export async function issueMemberToken(source: SecretSource, userId: string, nowMs = Date.now()): Promise<MemberToken> {
  const stepMs = MEMBER_TOKEN_STEP_SECONDS * 1000;
  const step = Math.floor(nowMs / stepMs);
  const mac = await crypto.subtle.sign('HMAC', await key(source), new TextEncoder().encode(`${userId}:${step}`));
  const sig = Array.from(new Uint8Array(mac, 0, SIGNATURE_BYTES), (b) => b.toString(16).padStart(2, '0')).join('');
  return {
    token: `${userId}.${step}.${sig}`,
    step_seconds: MEMBER_TOKEN_STEP_SECONDS,
    expires_in_ms: (step + 1) * stepMs - nowMs,
  };
}
