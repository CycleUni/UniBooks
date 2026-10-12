import { CountCapPipe, DEFAULT_COUNT_CAP } from './count-cap.pipe';

describe('CountCapPipe', () => {
  let pipe: CountCapPipe;

  beforeEach(() => {
    pipe = new CountCapPipe();
  });

  it('renders numbers below threshold as-is', () => {
    expect(pipe.transform(1)).toBe('1');
    expect(pipe.transform(42)).toBe('42');
    expect(pipe.transform(9998)).toBe('9998');
  });

  it('renders number exactly at threshold as-is', () => {
    expect(pipe.transform(9999)).toBe('9999');
    expect(pipe.transform(DEFAULT_COUNT_CAP)).toBe('9999');
  });

  it('renders numbers above threshold with plus suffix', () => {
    expect(pipe.transform(10000)).toBe('9999+');
    expect(pipe.transform(10001)).toBe('9999+');
    expect(pipe.transform(100000)).toBe('9999+');
  });

  it('renders zero as string zero', () => {
    expect(pipe.transform(0)).toBe('0');
  });

  it('handles null, undefined, and empty string safely', () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform('')).toBe('');
  });

  it('handles numeric string inputs correctly', () => {
    expect(pipe.transform('500')).toBe('500');
    expect(pipe.transform('9999')).toBe('9999');
    expect(pipe.transform('10000')).toBe('9999+');
  });

  it('handles non-numeric string inputs by returning them unchanged', () => {
    expect(pipe.transform('-')).toBe('-');
    expect(pipe.transform('N/A')).toBe('N/A');
  });

  it('supports custom cap threshold', () => {
    expect(pipe.transform(50, 50)).toBe('50');
    expect(pipe.transform(51, 50)).toBe('50+');
    expect(pipe.transform(100, 99)).toBe('99+');
  });
});
