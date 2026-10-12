import { describe, it, expect } from 'vitest';
import { decodeJwtPayload } from './jwt';

function jwtWith(payload: object): string {
  const b64url = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${b64url}.signature`;
}

describe('decodeJwtPayload', () => {
  it('reads a payload whose base64url form has - and _', () => {
    // "?>?" encodes to base64 with '+' and '/', so base64url has '-' and '_'.
    const token = jwtWith({ user_id: '42', pad: '?>??>?' });
    expect(token.split('.')[1]).toMatch(/[-_]/);
    expect(decodeJwtPayload(token)?.['user_id']).toBe('42');
  });

  it('returns null for something that is not a JWT', () => {
    expect(decodeJwtPayload('not-a-token')).toBeNull();
    expect(decodeJwtPayload('a.%%%.c')).toBeNull();
  });
});
