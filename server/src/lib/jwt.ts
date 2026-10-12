import { SignJWT, jwtVerify } from 'jose';

/**
 * Every token this Worker signs carries a `token_type` claim (the standard claim
 * name for this), and every verify
 * names the one type it accepts. Without that, any token signed with the same
 * key passed for any other: a 14-day refresh token or a 15-minute upload URL
 * opened the whole API as an access token.
 *
 * Keys: access/refresh/upload use JWT_SIGNING_KEY; chat/hub use
 * EDGE_CHAT_JWT_SECRET. Both are required — there is no fallback from one to
 * the other.
 */
export type TokenType = 'access' | 'refresh' | 'chat' | 'hub' | 'upload';

export interface AccessTokenPayload {
  user_id: string;
}

export interface RefreshTokenPayload {
  user_id: string;
  jti: string;
  family_id: string;
}

export interface ChatTokenPayload {
  user_id: string;
  room_id: string;
  app_id: string;
  participant_ids: string[];
  /** 'user' may write; 'observer' (moderator, or a chat whose listing is gone) may only read. */
  role: 'user' | 'observer' | 'system';
}

export interface HubTokenPayload {
  user_id: string;
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
      : T extends 'hub'
        ? HubTokenPayload
        : UploadTokenPayload;

export const TOKEN_LIFETIMES: Record<TokenType, string> = {
  access: '15m',
  refresh: '14d',
  chat: '1h',
  hub: '24h',
  upload: '15m',
};

const MIN_SECRET_LENGTH = 32;

function key(secret: string | undefined): Uint8Array {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    // Fail closed: a missing or short key must never sign or accept anything.
    throw new Error(`Signing secret missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  return new TextEncoder().encode(secret);
}

export async function signToken<T extends TokenType>(
  type: T,
  payload: PayloadFor<T>,
  secret: string | undefined,
  expiresIn: string = TOKEN_LIFETIMES[type],
): Promise<string> {
  return new SignJWT({ ...payload, token_type: type })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setJti(type === 'refresh' ? (payload as RefreshTokenPayload).jti : crypto.randomUUID())
    .setExpirationTime(expiresIn)
    .sign(key(secret));
}

export class InvalidTokenError extends Error {}

/** Verify signature, expiry, and that the token is of `type`. Throws InvalidTokenError otherwise. */
export async function verifyToken<T extends TokenType>(
  type: T,
  token: string,
  secret: string | undefined,
): Promise<PayloadFor<T> & { exp: number; iat: number; jti: string }> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] }));
  } catch (e) {
    throw new InvalidTokenError(e instanceof Error ? e.message : 'invalid token');
  }
  if (payload.token_type !== type || typeof payload.user_id !== 'string') {
    throw new InvalidTokenError('wrong token type');
  }
  return payload as unknown as PayloadFor<T> & { exp: number; iat: number; jti: string };
}
