import { describe, it, expect } from 'vitest';
import { parseMeetupTime, formatLocal } from '../../src/services/orders/time';
import { lockKeyFor } from '../../src/services/orders/transitions';

describe('meetup time parsing', () => {
  it('reads a naive time in the region timezone and stores UTC', () => {
    expect(parseMeetupTime('2030-01-02T18:30', 'Asia/Taipei')).toBe('2030-01-02T10:30:00.000Z');
    expect(parseMeetupTime('2030-01-02', 'Asia/Hong_Kong')).toBe('2030-01-01T16:00:00.000Z');
  });

  it('keeps an aware time as given', () => {
    expect(parseMeetupTime('2030-01-02T18:30:00+08:00', 'Asia/Taipei')).toBe('2030-01-02T10:30:00.000Z');
    expect(parseMeetupTime('2030-01-02T10:30:00Z', null)).toBe('2030-01-02T10:30:00.000Z');
  });

  it('treats null / empty as a clear and rejects junk', () => {
    expect(parseMeetupTime(null, 'Asia/Taipei')).toBeNull();
    expect(parseMeetupTime('', 'Asia/Taipei')).toBeNull();
    expect(parseMeetupTime('tomorrow', 'Asia/Taipei')).toBeUndefined();
    expect(parseMeetupTime('2030-02-30T10:00', 'Asia/Taipei')).toBeUndefined();
    expect(parseMeetupTime(12345, 'Asia/Taipei')).toBeUndefined();
  });

  it('formats in the region timezone', () => {
    expect(formatLocal('2030-01-02T10:30:00.000Z', 'Asia/Taipei')).toBe('2030-01-02 18:30');
    expect(formatLocal('2030-01-02T10:30:00.000Z', 'Not/AZone')).toBe('2030-01-02 18:30');
  });
});

describe('order lock keys', () => {
  it('locks on the listing while there is one', () => {
    expect(lockKeyFor({ id: 'o1', listingId: 'l1' })).toBe('listing:l1');
    expect(lockKeyFor({ id: 'o1', listingId: null })).toBe('order:o1');
  });
});
