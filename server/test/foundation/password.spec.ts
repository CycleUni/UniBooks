import { describe, it, expect } from 'vitest';
import { hashPassword, needsRehash, PBKDF2_ITERATIONS, verifyPassword } from '../../src/lib/crypto';

describe('password hashing (PBKDF2-SHA256, Django format)', () => {
  it('hashes with a fresh salt and verifies only the right password', async () => {
    const a = await hashPassword('Correct-Pass-123!');
    const b = await hashPassword('Correct-Pass-123!');
    expect(a).toMatch(new RegExp(`^pbkdf2_sha256\\$${PBKDF2_ITERATIONS}\\$[A-Za-z0-9]{22}\\$[A-Za-z0-9+/]{43}=$`));
    expect(a).not.toBe(b);
    expect(await verifyPassword('Correct-Pass-123!', a)).toBe(true);
    expect(await verifyPassword('correct-pass-123!', a)).toBe(false);
    expect(needsRehash(a)).toBe(false);
  });

  it('verifies a Django-made hash with fewer iterations and flags it for an upgrade', async () => {
    // Django's PBKDF2PasswordHasher with iterations=10000, salt 'seasalt' (vector from hashlib.pbkdf2_hmac).
    const django = 'pbkdf2_sha256$10000$seasalt$p2Nf8SH5q1HFJUvFvVd4Nj71pVA5fI7cpL2WDbb86bc=';
    expect(await verifyPassword('password', django)).toBe(true);
    expect(await verifyPassword('Password', django)).toBe(false);
    expect(needsRehash(django)).toBe(true);
  });

  it('rejects anything it cannot parse, including bcrypt and over-limit iteration counts', async () => {
    expect(await verifyPassword('x', '$2b$12$llUQrmJ1Saakp22/kxuFZuv8q25MI.qf1UfIrkGq311vhUrV39tva')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2_sha256$999999999$c2FsdA==$aGFzaA==')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});
