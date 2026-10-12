import { BookCoverPipe } from './book-cover.pipe';

describe('BookCoverPipe', () => {
  const pipe = new BookCoverPipe();

  it('proxies a Google Books cover at the requested zoom, without the curl edge', () => {
    const url = pipe.transform('https://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=1&edge=curl', 3);
    const src = new URL(url, 'https://example.test').searchParams.get('src')!;
    expect(url.startsWith('/api/cover?src=')).toBe(true);
    expect(new URL(src).searchParams.get('zoom')).toBe('3');
    expect(new URL(src).searchParams.has('edge')).toBe(false);
  });

  it('proxies Open Library and ISBNnet covers as they are', () => {
    const ol = 'https://covers.openlibrary.org/b/id/1312568-M.jpg';
    expect(new URL(pipe.transform(ol, 3), 'https://example.test').searchParams.get('src')).toBe(ol);
  });

  it('tells the Angular service worker to leave proxied covers alone', () => {
    // Matched by ngsw-worker.js as /[?&]ngsw-bypass(?:[=&]|$)/ on the search.
    for (const url of ['https://books.google.com/books/content?id=X', 'https://covers.openlibrary.org/b/id/1-M.jpg']) {
      expect(/[?&]ngsw-bypass(?:[=&]|$)/.test(pipe.transform(url, 3))).toBe(true);
    }
  });

  it('leaves other URLs (uploaded photos) untouched', () => {
    const r2 = 'https://pub-example.r2.dev/listings/a.png';
    expect(pipe.transform(r2, 3)).toBe(r2);
    expect(pipe.transform('', 3)).toBe('');
  });
});
