import { describe, it, expect } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { MAX_JSON_BODY_BYTES, readJson } from '../../src/lib/http';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => ({
  raw: new Request('https://unibooks.app/api/v1/x', { method: 'POST', body, headers }),
});

describe('readJson', () => {
  it('reads a JSON object', async () => {
    await expect(readJson(post('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it('treats an absent, malformed or non-object body as empty', async () => {
    await expect(readJson(post(null))).resolves.toEqual({});
    await expect(readJson(post('{oops'))).resolves.toEqual({});
    await expect(readJson(post('[1,2]'))).resolves.toEqual({});
    await expect(readJson(post('null'))).resolves.toEqual({});
  });

  it('refuses a body past the cap with a 413', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(MAX_JSON_BODY_BYTES) });
    const err = await readJson(post(big)).catch((e) => e);
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(413);
  });

  it('accepts a body just under the cap', async () => {
    const body = JSON.stringify({ a: 'x'.repeat(MAX_JSON_BODY_BYTES - 16) });
    await expect(readJson(post(body))).resolves.toHaveProperty('a');
  });
});
