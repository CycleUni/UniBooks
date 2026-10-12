import { bookIsbn, cleanAndValidateIsbn, clean_and_validate_isbn, isBooklandIsbn, isValidIsbnChecksum, isbnFromScan } from './isbn';

describe('isBooklandIsbn', () => {
  it('accepts ISBN-13s in the 978 and 979 prefixes, and ISBN-10s', () => {
    expect(isBooklandIsbn('9780134685991')).toBe(true);
    expect(isBooklandIsbn('9791032710586')).toBe(true);
    expect(isBooklandIsbn('000000006X')).toBe(true);
  });

  it('rejects a checksum-valid EAN-13 whose leading digits were misread', () => {
    // 9780134685991 with its 2nd and 3rd digits misread: still a valid EAN-13.
    expect(isValidIsbnChecksum('9090134685991')).toBe(true);
    expect(isBooklandIsbn('9090134685991')).toBe(false);
  });
});

describe('isValidIsbnChecksum', () => {
  it('accepts real ISBN-13 and ISBN-10 check digits', () => {
    expect(isValidIsbnChecksum('9786264140720')).toBe(true);
    expect(isValidIsbnChecksum('0306406152')).toBe(true);
    expect(isValidIsbnChecksum('000000006X')).toBe(true);
  });

  it('rejects a same-length, all-digit misread with the wrong check digit', () => {
    // Right shape (13 digits), wrong content — e.g. a garbled camera scan.
    expect(isValidIsbnChecksum('9786264140721')).toBe(false);
    expect(isValidIsbnChecksum('0123456788')).toBe(false);
  });
});

describe('cleanAndValidateIsbn', () => {
  it('should accept valid 13-digit ISBNs', () => {
    expect(cleanAndValidateIsbn('9786264140720')).toBe('9786264140720');
    expect(cleanAndValidateIsbn('978-626-414-072-0')).toBe('9786264140720');
    expect(cleanAndValidateIsbn(' 978 626 414 072 0 ')).toBe('9786264140720');
    expect(cleanAndValidateIsbn('9791234567890')).toBe('9791234567890');
  });

  it('should accept valid 10-digit ISBNs including trailing X check digit', () => {
    expect(cleanAndValidateIsbn('0306406152')).toBe('0306406152');
    expect(cleanAndValidateIsbn('0-306-40615-2')).toBe('0306406152');
    expect(cleanAndValidateIsbn('012345678X')).toBe('012345678X');
    expect(cleanAndValidateIsbn('0-1234-5678-x')).toBe('012345678X');
    expect(cleanAndValidateIsbn(' 012345678X ')).toBe('012345678X');
  });

  it('should reject invalid QR codes and URLs', () => {
    expect(cleanAndValidateIsbn('https://example.com/some-qr-payload')).toBeNull();
    expect(cleanAndValidateIsbn('WIFI:S:MyNetwork;T:WPA;P:password;;')).toBeNull();
    expect(cleanAndValidateIsbn('invalid barcode')).toBeNull();
  });

  it('should reject strings with invalid lengths', () => {
    expect(cleanAndValidateIsbn('123')).toBeNull();
    expect(cleanAndValidateIsbn('123456789')).toBeNull();
    expect(cleanAndValidateIsbn('12345678901')).toBeNull(); // 11 digits
    expect(cleanAndValidateIsbn('123456789012')).toBeNull(); // 12 digits
    expect(cleanAndValidateIsbn('12345678901234')).toBeNull(); // 14 digits
  });

  it('should reject strings with non-digits in invalid positions', () => {
    expect(cleanAndValidateIsbn('97862641407XX')).toBeNull();
    expect(cleanAndValidateIsbn('978626A140720')).toBeNull();
    expect(cleanAndValidateIsbn('978-0-1234-5678-X')).toBeNull(); // ISBN-13 with X is invalid
    expect(cleanAndValidateIsbn('X123456789')).toBeNull(); // X at start of 10-char
    expect(cleanAndValidateIsbn('01234567X9')).toBeNull(); // X in middle of 10-char
  });

  it('should reject empty or null inputs', () => {
    expect(cleanAndValidateIsbn('')).toBeNull();
    expect(cleanAndValidateIsbn(null)).toBeNull();
    expect(cleanAndValidateIsbn(undefined)).toBeNull();
  });

  it('should expose clean_and_validate_isbn alias matching backend naming', () => {
    expect(clean_and_validate_isbn('9786264140720')).toBe('9786264140720');
  });
});

describe('isbnFromScan', () => {
  it('returns the ISBN for a real book barcode', () => {
    expect(isbnFromScan('9780134685991')).toBe('9780134685991');
  });

  it('rejects a wrong check digit, a non-book EAN-13 and non-ISBN codes', () => {
    expect(isbnFromScan('9780134685992')).toBeNull();
    expect(isbnFromScan('9090134685991')).toBeNull();
    expect(isbnFromScan('https://example.com')).toBeNull();
  });
});

describe('bookIsbn', () => {
  it('cleans a real ISBN-13 or ISBN-10', () => {
    expect(bookIsbn('978-986-06-2920-0')).toBe('9789860629200');
    expect(bookIsbn('080442957x')).toBe('080442957X');
  });

  it('refuses a misread outside 978/979, a wrong check digit and empty input', () => {
    expect(bookIsbn('6770250629200')).toBeNull();
    expect(bookIsbn('9789860629201')).toBeNull();
    expect(bookIsbn('')).toBeNull();
    expect(bookIsbn(undefined)).toBeNull();
  });
});
