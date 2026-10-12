/**
 * Google ID-token verification RS256 signature against Google's published keys,
 * issuer, audience (our GOOGLE_CLIENT_ID) and expiry, with 5 s of clock-skew
 * leeway. Done with WebCrypto directly: this is Google's token, not one of
 * ours, so it does not go through utils/jwt.
 */

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const LEEWAY_SECONDS = 5;

export interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  exp: number;
  iat?: number;
}

/** The credential is not a valid Google ID token for this app (401). */
export class GoogleTokenInvalid extends Error {}
/** Google's keys could not be fetched: our outage, not a bad credential (503). */
export class GoogleUnavailable extends Error {}

interface Jwks {
  keys: (JsonWebKey & { kid?: string })[];
}

let keyCache: { at: number; maxAge: number; jwks: Jwks } | null = null;

/** Where the keys come from. Replaced in tests. */
export const googleKeys = {
  async fetchJwks(): Promise<Jwks> {
    if (keyCache && Date.now() - keyCache.at < keyCache.maxAge) return keyCache.jwks;
    let res: Response;
    try {
      res = await fetch(CERTS_URL);
    } catch (e) {
      throw new GoogleUnavailable(String(e));
    }
    if (!res.ok) throw new GoogleUnavailable(`certs HTTP ${res.status}`);
    const jwks = (await res.json()) as Jwks;
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1] ?? 3600) * 1000;
    keyCache = { at: Date.now(), maxAge, jwks };
    return jwks;
  },
};

function b64urlDecode(part: string): Uint8Array {
  const b64 = part
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
}

export async function verifyGoogleIdToken(credential: string, clientId: string): Promise<GoogleClaims> {
  const parts = credential.split('.');
  if (parts.length !== 3) throw new GoogleTokenInvalid('not a JWT');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
    signature = b64urlDecode(parts[2]);
  } catch {
    throw new GoogleTokenInvalid('malformed');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleTokenInvalid('bad header');

  const jwks = await googleKeys.fetchJwks();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new GoogleTokenInvalid('unknown kid');

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    ok = false;
  }
  if (!ok) throw new GoogleTokenInvalid('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iss !== 'string' || !ISSUERS.has(payload.iss)) throw new GoogleTokenInvalid('bad issuer');
  const aud = payload.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) throw new GoogleTokenInvalid('bad audience');
  if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_SECONDS < now) throw new GoogleTokenInvalid('expired');
  if (typeof payload.iat === 'number' && payload.iat - LEEWAY_SECONDS > now) throw new GoogleTokenInvalid('issued in the future');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new GoogleTokenInvalid('no subject');
  return payload as unknown as GoogleClaims;
}
