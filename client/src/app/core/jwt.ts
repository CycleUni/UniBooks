/**
 * The payload of a JWT, or null when it cannot be read.
 *
 * JWTs are base64url: '-' and '_' where base64 has '+' and '/'. Plain atob()
 * throws on those, and whether a token contains one depends on its bytes —
 * so decoding without converting first failed for some users' tokens and not
 * others, and the chat silently never learnt who it was talking as.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}
