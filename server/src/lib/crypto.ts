import bcrypt from 'bcryptjs';

/**
 * Hash a plaintext password using bcrypt with 12 salt rounds.
 *
 * @param password - Plaintext password to hash
 * @returns Hashed password string
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 *
 * @param password - Plaintext password to verify
 * @param hash - Stored bcrypt hash
 * @returns Boolean indicating whether the password matches
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
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
