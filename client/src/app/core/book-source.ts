/**
 * The i18n key naming each catalogue `source` the backend records on a book.
 * Spelled out rather than built from the value, so a source this list does
 * not know yet (or a missing one) shows nothing instead of a raw key.
 */
export const BOOK_SOURCE_LABEL_KEYS: Readonly<Record<string, string>> = {
  google_api: 'book.sourceGoogle',
  openlibrary_api: 'book.sourceOpenLibrary',
  isbnnet_api: 'book.sourceIsbnnet',
  manual: 'book.sourceManual',
  listed: 'book.sourceListed',
  preseed: 'book.sourcePreseed',
};

export function bookSourceLabelKey(source: unknown): string | null {
  return typeof source === 'string' && Object.hasOwn(BOOK_SOURCE_LABEL_KEYS, source)
    ? BOOK_SOURCE_LABEL_KEYS[source]
    : null;
}
