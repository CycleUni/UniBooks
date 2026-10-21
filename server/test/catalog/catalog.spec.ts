import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { cleanAndValidateIsbn, isbnChecksumOk, isbnForms, validateBookIsbn } from '../../src/services/catalog/isbn';
import { cleanCoverUrl, cleanPublisher, describeSource } from '../../src/services/catalog/common';
import { engineOrder, regionSearchEngines, ISBN_FALLBACK_ORDER } from '../../src/services/catalog/lookups';
import { PhotoError, acceptListingPhotos, settlePhotos } from '../../src/services/listings/photos';
import { seedListing, seedRegion, seedUser } from '../messaging/helpers';
import { sniffImage as detectImageExtension, publicBase, storageKeyFromUrl, validatedContentLength } from '../../src/lib/media';

const ORIGIN = 'http://x';
const BASE = publicBase(env, ORIGIN);
const hex = 'a'.repeat(32);

describe('ISBN helpers', () => {
  it('cleans, checks and converts ISBNs', () => {
    expect(cleanAndValidateIsbn('978-0-13-110362-7')).toBe('9780131103627');
    expect(cleanAndValidateIsbn('97801311036２7')).toBeNull(); // fullwidth digit
    expect(isbnChecksumOk('9780131103627')).toBe(true);
    expect(validateBookIsbn('9780131103628')).toBeNull(); // bad check digit
    expect(validateBookIsbn('0131103628')).toBe('0131103628');
    expect([...isbnForms('9780131103627')]).toContain('0131103628');
  });
});

describe('catalogue helpers', () => {
  it('cleans publisher quotes and cover URLs', () => {
    expect(cleanPublisher('"O\'Reilly Media, Inc."')).toBe("O'Reilly Media, Inc.");
    expect(cleanPublisher('"A" & "B"')).toBe('"A" & "B"');
    expect(cleanCoverUrl('javascript:alert(1)')).toBeNull();
    expect(cleanCoverUrl('ftp://example.com/a.jpg')).toBeNull();
    expect(cleanCoverUrl('http://books.google.com/a.jpg')).toBe('http://books.google.com/a.jpg');
    expect(cleanCoverUrl('https://example.com/' + 'a'.repeat(1100))).toBeNull();
    expect(describeSource('isbnnet', true)).toBe('ISBNnet cache');
  });

  it('keeps engines inside what the region allows', () => {
    const allowed = regionSearchEngines({ searchEngines: '["openlibrary","isbnnet"]' } as never);
    expect(allowed).toEqual(['openlibrary', 'isbnnet']);
    expect(engineOrder('googlebooks', allowed, ISBN_FALLBACK_ORDER)).toEqual(['isbnnet', 'openlibrary']);
    expect(engineOrder('openlibrary', allowed, ISBN_FALLBACK_ORDER)).toEqual(['openlibrary']);
    expect(regionSearchEngines(null)).toEqual(['googlebooks']);
  });
});

describe('listing photo keys', () => {
  it('sniffs magic bytes and bounds sizes', () => {
    expect(detectImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(detectImageExtension(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(validatedContentLength(10)).toBe(10);
    expect(validatedContentLength(0)).toBeNull();
    expect(validatedContentLength(6 * 1024 * 1024)).toBeNull();
    expect(validatedContentLength(true)).toBeNull();
  });

  it('resolves only URLs on the public base, without traversal', () => {
    expect(storageKeyFromUrl(env, ORIGIN, `${BASE}/listings/u1/${hex}.jpg`)).toEqual({ key: `listings/u1/${hex}.jpg` });
    expect(storageKeyFromUrl(env, ORIGIN, `https://evil.example/listings/u1/${hex}.jpg`)).toEqual({ error: 'host' });
    expect(storageKeyFromUrl(env, ORIGIN, `${BASE}/listings/u1/..%2fu2/${hex}.jpg`)).toEqual({ error: 'invalid' });
    expect(storageKeyFromUrl(env, ORIGIN, `${BASE}/listings/u1/${hex}.jpg?x=1`)).toEqual({ error: 'invalid' });
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof PhotoError ? e.code : String(e);
    }
  };

  it("rejects another user's uploads and keys not on the listing", async () => {
    expect(await code(acceptListingPhotos(env, ORIGIN, [`${BASE}/tmp/listings/u2/${hex}.jpg`], 'u1'))).toBe('listing.errPhotoNotOwned');
    expect(await code(acceptListingPhotos(env, ORIGIN, [`${BASE}/listings/u2/${hex}.jpg`], 'u1'))).toBe('listing.errPhotoNotOwned');
    expect(await code(acceptListingPhotos(env, ORIGIN, [`${BASE}/avatars/u1/${hex}.jpg`], 'u1'))).toBe('listing.errPhotoNotOwned');
    expect(await code(acceptListingPhotos(env, ORIGIN, [`https://evil.example/x.jpg`], 'u1'))).toBe('listing.errPhotoHostNotAllowed');
    expect(await code(acceptListingPhotos(env, ORIGIN, 'nope', 'u1'))).toBe('listing.errInvalidPhotos');
    expect(await code(acceptListingPhotos(env, ORIGIN, Array(7).fill('x'), 'u1'))).toBe('listing.errTooManyPhotos');
    // The listing's own permanent photo may be sent back unchanged.
    const kept = `${BASE}/listings/u1/${hex}.jpg`;
    expect((await acceptListingPhotos(env, ORIGIN, [kept], 'u1', [kept])).urls).toEqual([kept]);
  });

  it("promotes the caller's own tmp upload to their permanent prefix", async () => {
    const tmpKey = `tmp/listings/u1/${hex}.png`;
    await env.R2.put(tmpKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const out = await acceptListingPhotos(env, ORIGIN, [`${BASE}/${tmpKey}`], 'u1');
    expect(out.urls).toEqual([`${BASE}/listings/u1/${hex}.png`]);
    expect(await env.R2.head(`listings/u1/${hex}.png`)).not.toBeNull();
    // The upload stays until the listing write commits...
    expect(await env.R2.head(tmpKey)).not.toBeNull();
    await settlePhotos(env, ORIGIN, 'u1', out, true);
    expect(await env.R2.head(tmpKey)).toBeNull();
  });

  it('a write that did not commit removes the copies and keeps the upload for a retry', async () => {
    const name = 'c'.repeat(32);
    const tmpKey = `tmp/listings/u1/${name}.png`;
    await env.R2.put(tmpKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const out = await acceptListingPhotos(env, ORIGIN, [`${BASE}/${tmpKey}`], 'u1');
    await settlePhotos(env, ORIGIN, 'u1', out, false);
    expect(await env.R2.head(`listings/u1/${name}.png`)).toBeNull();
    expect(await env.R2.head(tmpKey)).not.toBeNull();
  });

  it('never replaces a photo another listing shows, even if its name turns up in tmp again', async () => {
    await seedRegion();
    const seller = await seedUser({ verifiedIn: 'TW' });
    const name = 'e'.repeat(32);
    const permKey = `listings/${seller.id}/${name}.png`;
    await env.R2.put(permKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]));
    const holder = await seedListing(seller.id);
    await env.DB.prepare('UPDATE listings SET photos = ? WHERE id = ?')
      .bind(JSON.stringify([`${BASE}/${permKey}`]), holder)
      .run();

    const tmpKey = `tmp/listings/${seller.id}/${name}.png`;
    await env.R2.put(tmpKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]));
    expect(await code(acceptListingPhotos(env, ORIGIN, [`${BASE}/${tmpKey}`], seller.id))).toBe('listing.errPhotoPromoteFailed');
    expect(new Uint8Array(await (await env.R2.get(permKey))!.arrayBuffer())[4]).toBe(1);
  });

  it('a committed edit deletes the photos it dropped', async () => {
    const key = `listings/u1/${'d'.repeat(32)}.png`;
    await env.R2.put(key, new Uint8Array([1]));
    await settlePhotos(env, ORIGIN, 'u1', { urls: [], tmpKeys: [], promoted: [] }, true, [`${BASE}/${key}`]);
    expect(await env.R2.head(key)).toBeNull();
  });
});
