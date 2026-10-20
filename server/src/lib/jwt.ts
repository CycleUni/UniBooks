import { SignJWT, jwtVerify } from 'jose';

/**
 * Every token this Worker signs carries a `token_type` claim (the standard claim
 * name for this), and every verify
 * names the one type it accepts. Without that, any token signed with the same
 * key passed for any other: a 14-day refresh token or a 15-minute upload URL
 * opened the whole API as an access token.
 *
 * Keys: one secret, SECRET_KEY, from which HKDF-SHA256
 * derives a separate HMAC-SHA256 key per token type. A token of one type
 * fails the signature check as any other, on top of the token_type check,
 * and there is only one secret to set and rotate (rotating it signs
 * everyone out).
 */
export type TokenType = 'access' | 'refresh' | 'chat' | 'upload';

export interface AccessTokenPayload {
  user_id: string;
  /** When the user last proved who they are (password, Google, passkey), in epoch seconds; carried through refreshes. */
  auth_time?: number;
}

export interface RefreshTokenPayload {
  user_id: string;
  jti: string;
  family_id: string;
  auth_time?: number;
}

export interface ChatTokenPayload {
  user_id: string;
  room_id: string;
  app_id: string;
  participant_ids: string[];
  /** 'user' may write; 'observer' (moderator, or a chat whose listing is gone) may only read. */
  role: 'user' | 'observer' | 'system';
}

export interface UploadTokenPayload {
  user_id: string;
  /** What the upload is for; each upload endpoint accepts exactly one. */
  action: 'listing_photo' | 'chat_image' | 'avatar' | 'ad_image';
  /** R2 object key the bytes are written to. */
  target_key: string;
  /** The Content-Type the upload was authorised for. */
  content_type: string;
  max_bytes: number;
}

type PayloadFor<T extends TokenType> = T extends 'access'
  ? AccessTokenPayload
  : T extends 'refresh'
    ? RefreshTokenPayload
    : T extends 'chat'
      ? ChatTokenPayload
      : UploadTokenPayload;

export const TOKEN_LIFETIMES: Record<TokenType, string> = {
  access: '15m',
  refresh: '14d',
  chat: '1h',
  upload: '15m',
};

const MIN_SECRET_LENGTH = 32;

/** Where the master secret comes from: the Worker env (or any object carrying it). */
export interface SecretSource {
  SECRET_KEY?: string;
}

/** Derived keys per (secret, type), kept for the isolate's life: HKDF runs once per type. */
const derived = new Map<string, Promise<CryptoKey>>();

function key(source: SecretSource, type: TokenType): Promise<CryptoKey> {
  const secret = source.SECRET_KEY;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    // Fail closed: a missing or short key must never sign or accept anything.
    throw new Error(`SECRET_KEY missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  const cacheKey = `${type}\u0000${secret}`;
  let k = derived.get(cacheKey);
  if (!k) {
    const enc = new TextEncoder();
    k = crypto.subtle
      .importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((master) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`unibooks/jwt/${type}`) },
          master,
          { name: 'HMAC', hash: 'SHA-256', length: 256 },
          false,
          ['sign', 'verify'],
        ),
      );
    derived.set(cacheKey, k);
  }
  return k;
}

export async function signToken<T extends TokenType>(
  type: T,
  payload: PayloadFor<T>,
  source: SecretSource,
  expiresIn: string = TOKEN_LIFETIMES[type],
): Promise<string> {
  return new SignJWT({ ...payload, token_type: type })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setJti(type === 'refresh' ? (payload as RefreshTokenPayload).jti : crypto.randomUUID())
    .setExpirationTime(expiresIn)
    .sign(await key(source, type));
}

export class InvalidTokenError extends Error {}

/** Verify signature, expiry, and that the token is of `type`. Throws InvalidTokenError otherwise. */
export async function verifyToken<T extends TokenType>(
  type: T,
  token: string,
  source: SecretSource,
): Promise<PayloadFor<T> & { exp: number; iat: number; jti: string }> {
  const k = await key(source, type);
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, k, { algorithms: ['HS256'] }));
  } catch (e) {
    throw new InvalidTokenError(e instanceof Error ? e.message : 'invalid token');
  }
  if (payload.token_type !== type || typeof payload.user_id !== 'string') {
    throw new InvalidTokenError('wrong token type');
  }
  return payload as unknown as PayloadFor<T> & { exp: number; iat: number; jti: string };
}
