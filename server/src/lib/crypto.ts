/**
 * Password hashing: PBKDF2-HMAC-SHA256 through Web Crypto, the hasher the
 * Workers runtime implements natively (bcrypt or argon2 would run as
 * JavaScript or WASM and cost a few hundred ms of CPU per sign-in). A hash
 * is stored self-describing, so its parameters can change later:
 *
 *   pbkdf2_sha256$<iterations>$<salt>$<hash, base64>
 *
 * (the salt is a random alphanumeric string, used as its UTF-8 bytes).
 * PBKDF2_ITERATIONS is the most the runtime accepts (100 000). A hash made
 * with fewer is upgraded at the next sign-in (needsRehash), so the count can
 * only go up without anyone resetting a password.
 */
export const PBKDF2_ITERATIONS = 100_000;
/** Salt: 22 random alphanumerics (~131 bits). */
const SALT_LENGTH = 22;
const SALT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HASH_BYTES = 32;
const ALGORITHM = 'pbkdf2_sha256';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

function randomSalt(): string {
  // Rejection sampling keeps every character equally likely.
  let out = '';
  while (out.length < SALT_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SALT_LENGTH))) {
      if (byte < 248 && out.length < SALT_LENGTH) out += SALT_ALPHABET[byte % SALT_ALPHABET.length];
    }
  }
  return out;
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations },
    material,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomSalt();
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${ALGORITHM}$${PBKDF2_ITERATIONS}$${salt}$${b64(hash)}`;
}

function parse(stored: string): { iterations: number; salt: string; hash: Uint8Array } | null {
  const [algorithm, rawIterations, salt, hash, ...rest] = stored.split('$');
  const iterations = Number(rawIterations);
  if (algorithm !== ALGORITHM || rest.length || !salt || !hash) return null;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return null;
  try {
    return { iterations, salt, hash: unb64(hash) };
  } catch {
    return null;
  }
}

/** Whether `password` matches `stored`, compared in constant time. False for anything unparseable. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const candidate = await pbkdf2(password, parsed.salt, parsed.iterations);
  if (candidate.byteLength !== parsed.hash.byteLength) return false;
  return crypto.subtle.timingSafeEqual(candidate, parsed.hash);
}

/** Whether a stored hash should be replaced at the next successful sign-in (older parameters). */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.iterations < PBKDF2_ITERATIONS || parsed.hash.byteLength !== HASH_BYTES;
}

/**
 * Compute the SHA-256 hex digest of a string using Web Crypto API.
 *
 * @param input - Input string to hash
 * @returns Lowercase hex string of SHA-256 digest
 */
export async function generateSHA256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a cryptographically secure random token.
 * Defaults to random hex bytes or UUID.
 *
 * @param bytes - Optional number of random bytes (default 32)
 * @returns Random hex string or UUID
 */
export function generateSecureToken(bytes: number = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
