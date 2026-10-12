import { Pipe, PipeTransform } from '@angular/core';

/**
 * The /api/cover URL for a catalogue cover. `ngsw-bypass` makes the Angular
 * service worker let the image request through untouched: it never caches
 * these (no asset group matches /api/cover), so intercepting them only added
 * a hop, and showed every cover twice in DevTools — once from the page, once
 * from the worker's own fetch. The API calls skip it the same way, by header.
 */
function proxied(src: string): string {
  return `/api/cover?src=${encodeURIComponent(src)}&ngsw-bypass=`;
}

/**
 * Transforms a Google Books API cover URL to a higher resolution by
 * replacing (or adding) the `zoom` query parameter.
 *
 * Usage: {{ url | bookCover: 2 }}
 * - zoom=1  → default (small, ~128px)
 * - zoom=2  → medium  (~300px) — use on /book page
 * - zoom=3  → large   (~800px) — use on /listing detail page
 */
@Pipe({
  name: 'bookCover',
  standalone: true,
  pure: true
})
export class BookCoverPipe implements PipeTransform {
  transform(url: string | null | undefined, zoom: 1 | 2 | 3 = 1): string {
    if (!url) return '';
    // Proxy Open Library / ISBNnet covers as-is (no zoom rewriting)
    if (url.includes('covers.openlibrary.org') || url.includes('pdsapp.ncl.edu.tw')) {
      return proxied(url);
    }
    // Only modify Google Books URLs
    if (!url.includes('books.google.com')) return url;
    try {
      const u = new URL(url);
      u.searchParams.set('zoom', String(zoom));
      // Also remove the decorative curl edge for cleaner cover images
      if (zoom >= 2) {
        u.searchParams.delete('edge');
      }
      return proxied(u.toString());
    } catch {
      return url;
    }
  }
}
