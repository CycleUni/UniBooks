import { Router } from '@angular/router';

/**
 * Navigation state a list page attaches to a book link, telling the book page
 * that it may render the preview the list stashed in sessionStorage
 * (`cachedBook_<isbn or id>`) while the real record loads.
 *
 * This used to be a `local_cache=true` query parameter. Being in the href, it
 * was copied into every shared link and indexed, so one book had two URLs
 * (with and without the flag) — and a visitor opening a shared one was told
 * to trust a sessionStorage entry their tab never wrote. Router state is not
 * part of the URL: it rides the in-app click, survives back/forward and a
 * reload of the same history entry, and is simply absent for a pasted link,
 * a new tab or a region switch (a full document load), which is exactly when
 * the preview should not be used.
 */
export function bookPreviewState(): { bookPreview: true } {
  // A function rather than an exported object constant: in the split test
  // bundle a module-level object const read from a component field
  // initializer was still undefined when the component was constructed.
  return { bookPreview: true };
}

export function hasBookPreviewState(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as Record<string, unknown>)['bookPreview'] === true;
}

/**
 * Whether the navigation that is showing the book page came from a list link.
 *
 * currentNavigation() covers a query change on a reused page, which is
 * reported while the navigation is still running; the page's first ngOnInit
 * runs in the change detection after it has finished, when only
 * lastSuccessfulNavigation() still holds the extras.
 */
export function navigationWantsBookPreview(router: Router): boolean {
  const navigation = router.currentNavigation() ?? router.lastSuccessfulNavigation();
  return hasBookPreviewState(navigation?.extras.state);
}

/** The route query that addresses a book: its ISBN when it has one, so every
 *  entry point links to the same URL, otherwise its catalogue id. */
export function bookQueryParams(book: { isbn?: string | null; id?: string | number | null }): Record<string, string | number> {
  if (book.isbn) return { isbn: book.isbn };
  return book.id != null && book.id !== '' ? { id: book.id } : {};
}
