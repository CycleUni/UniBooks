import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { storeGet, storePut } from '../../src/lib/cache';

describe('edge store', () => {
  it('returns what was put, and nothing for an unknown key', async () => {
    const key = `t:${crypto.randomUUID()}`;
    expect(await storeGet(key)).toBeNull();
    await storePut(key, '{"a":1}', 60);
    expect(await storeGet(key)).toBe('{"a":1}');
  });

  it('keeps keys apart, including ones with slashes and spaces', async () => {
    const id = crypto.randomUUID();
    await storePut(`t:${id}:a/b c`, 'one', 60);
    await storePut(`t:${id}:a/b`, 'two', 60);
    expect(await storeGet(`t:${id}:a/b c`)).toBe('one');
    expect(await storeGet(`t:${id}:a/b`)).toBe('two');
  });

  it('does not touch KV, whose free plan allows 1000 writes a day', async () => {
    const key = `t:${crypto.randomUUID()}`;
    await storePut(key, 'x', 60);
    expect(await env.KV.get(key)).toBeNull();
    expect((await env.KV.list({ prefix: 'catalog:' })).keys).toHaveLength(0);
  });
});
