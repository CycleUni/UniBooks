const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [['"', '"'], ['“', '”']];

/**
 * A publisher name without the quotation marks some catalogue records wrap
 * it in.
 *
 * Google Books returns `"O'Reilly Media, Inc."` with the quotes as part of
 * the value, and the book page printed them. The backend now strips them at
 * import and on output (catalog.services.clean_publisher); this covers
 * previews built from search results cached before that, and mirrors its
 * rule: only a pair wrapping the whole value, and only when that quote does
 * not also occur inside it.
 */
export function displayPublisher(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  for (const [open, close] of WRAPPING_QUOTES) {
    const inner = text.slice(open.length, text.length - close.length);
    if (
      text.length > open.length + close.length &&
      text.startsWith(open) &&
      text.endsWith(close) &&
      !inner.includes(open) &&
      !inner.includes(close)
    ) {
      return inner.trim();
    }
  }
  return text;
}
