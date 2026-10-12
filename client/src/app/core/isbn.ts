/**
 * ISBN checks shared by typed search, the sell form and barcode scans.
 */

/**
 * Cleans and validates an ISBN string (mirroring backend clean_and_validate_isbn).
 * Strips hyphens and whitespace, uppercases 'X', and validates:
 * - ISBN-13: exactly 13 digits (EAN-13)
 * - ISBN-10: exactly 10 characters (first 9 digits, last char digit or 'X')
 * Returns the cleaned ISBN string if valid, or null if invalid.
 */
export function cleanAndValidateIsbn(isbnStr: string | null | undefined): string | null {
  if (!isbnStr) {
    return null;
  }
  const rawIsbn = String(isbnStr).replace(/[-\s]/g, '').toUpperCase();
  const isAllDigits = /^\d+$/.test(rawIsbn);
  const is10WithX = rawIsbn.length === 10 && /^\d{9}[0-9X]$/.test(rawIsbn);
  if (isAllDigits || is10WithX) {
    if (rawIsbn.length === 10 || rawIsbn.length === 13) {
      return rawIsbn;
    }
  }
  return null;
}

export const clean_and_validate_isbn = cleanAndValidateIsbn;

/**
 * Verifies the ISBN-10/13 check digit. Deliberately kept separate from
 * cleanAndValidateIsbn (which mirrors the backend's format-only check used
 * for typed search input) — a camera misread can produce a string that's
 * the right length and all-digit but numerically wrong, which a checksum
 * catches and a length/format check alone cannot.
 */
export function isValidIsbnChecksum(isbn: string): boolean {
  if (isbn.length === 13) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    return check === Number(isbn[12]);
  }
  if (isbn.length === 10) {
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += Number(isbn[i]) * (10 - i);
    }
    const last = isbn[9] === 'X' ? 10 : Number(isbn[9]);
    sum += last;
    return sum % 11 === 0;
  }
  return false;
}

/**
 * Whether a 13-digit code can be a book's ISBN. Every ISBN-13 is an EAN-13 in
 * the 978/979 "Bookland" prefix, whatever the country (the country or
 * language group is the digits after it). Scans on iOS misread the leading
 * digits into a different, checksum-valid number; the prefix catches those.
 */
export function isBooklandIsbn(isbn: string): boolean {
  return isbn.length !== 13 || isbn.startsWith('978') || isbn.startsWith('979');
}

/**
 * The ISBN to store on a book, or null when the value can't be a book's: the
 * right shape, a valid check digit, and (for 13 digits) the 978/979 prefix.
 * Mirrors the backend's validate_book_isbn, which refuses anything else on
 * the way into the catalogue. Typed search keeps the format-only check: a
 * lookup that finds nothing leaves nothing wrong behind.
 */
export function bookIsbn(value: string | null | undefined): string | null {
  const isbn = cleanAndValidateIsbn(value);
  return isbn && isValidIsbnChecksum(isbn) && isBooklandIsbn(isbn) ? isbn : null;
}

/**
 * The ISBN a camera scan read, or null when the code can't be a book's.
 * The sell form and the search screen both take a scan through this.
 */
export function isbnFromScan(decodedText: string): string | null {
  return bookIsbn(decodedText);
}
