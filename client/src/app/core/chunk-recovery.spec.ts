import { importOrReload } from './chunk-recovery';

describe('importOrReload', () => {
  beforeEach(() => sessionStorage.clear());

  it('passes a loaded module through untouched', async () => {
    expect(await importOrReload(async () => ({ value: 1 }))).toEqual({ value: 1 });
    expect(sessionStorage.getItem('unibooks.chunkReload')).toBeNull();
  });

  it('starts a reload for a missing chunk, once, and still rejects for the caller', async () => {
    const gone = new Error('Failed to fetch dynamically imported module: https://unibooks.app/chunk-OLD.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
    await expect(importOrReload(() => Promise.reject(gone))).rejects.toBe(gone);
    const marker = JSON.parse(sessionStorage.getItem('unibooks.chunkReload')!);
    expect(marker.url).toBe(location.href);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://unibooks.app/chunk-OLD.js', { cache: 'reload' });
    vi.restoreAllMocks();
  });

  it('leaves other failures to the caller without reloading', async () => {
    await expect(importOrReload(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(sessionStorage.getItem('unibooks.chunkReload')).toBeNull();
  });
});
