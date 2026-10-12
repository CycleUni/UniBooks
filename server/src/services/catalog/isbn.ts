/**
 * ISBN helpers.
 */

// ASCII digits only: fullwidth or other Unicode digits would let a lookalike
// ISBN be stored as a different string from the real one.
const ISBN_SHAPE = /^(?:[0-9]{13}|[0-9]{9}[0-9X])$/;

/** Format-only cleaning for reads: hyphens/spaces dropped, uppercased; null when not ISBN-shaped. */
export function cleanAndValidateIsbn(value: unknown): string | null {
  if (value === null || value === undefined || value === '' || value === false) return null;
  const raw = String(value).replaceAll('-', '').replaceAll(' ', '').toUpperCase();
  return ISBN_SHAPE.test(raw) ? raw : null;
}

/** Whether a cleaned ISBN-10/13 carries a correct check digit. */
export function isbnChecksumOk(isbn: string): boolean {
  if (isbn.length === 13 && /^[0-9]{13}$/.test(isbn)) {
    let total = 0;
    for (let i = 0; i < 12; i++) total += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (total % 10)) % 10 === Number(isbn[12]);
  }
  if (isbn.length === 10 && /^[0-9]{9}/.test(isbn)) {
    let total = 0;
    for (let i = 0; i < 9; i++) total += Number(isbn[i]) * (10 - i);
    const last = isbn[9];
    if (last !== 'X' && !/[0-9]/.test(last)) return false;
    total += last === 'X' ? 10 : Number(last);
    return total % 11 === 0;
  }
  return false;
}

/**
 * The cleaned ISBN to store on a Book, or null: valid check digit and, for
 * 13 digits, the 978/979 Bookland prefix (camera misreads produce
 * checksum-valid non-book numbers).
 */
export function validateBookIsbn(value: unknown): string | null {
  const isbn = cleanAndValidateIsbn(value);
  if (!isbn || !isbnChecksumOk(isbn)) return null;
  if (isbn.length === 13 && !isbn.startsWith('978') && !isbn.startsWith('979')) return null;
  return isbn;
}

/** A cleaned ISBN together with its other-length form, when it has one. */
export function isbnForms(isbn: string): Set<string> {
  const forms = new Set([isbn]);
  if (isbn.length === 13 && isbn.startsWith('978')) {
    const core = isbn.slice(3, 12);
    let total = 0;
    for (let i = 0; i < 9; i++) total += Number(core[i]) * (10 - i);
    const check = (11 - (total % 11)) % 11;
    forms.add(core + (check === 10 ? 'X' : String(check)));
  } else if (isbn.length === 10 && /^[0-9]{9}/.test(isbn)) {
    const core = '978' + isbn.slice(0, 9);
    let total = 0;
    for (let i = 0; i < 12; i++) total += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    forms.add(core + String((10 - (total % 10)) % 10));
  }
  return forms;
}
