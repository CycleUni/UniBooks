import { displayPublisher } from './publisher';

describe('displayPublisher', () => {
  it('strips the quotes Google Books wraps some publishers in', () => {
    expect(displayPublisher('"O\'Reilly Media, Inc."')).toBe("O'Reilly Media, Inc.");
    expect(displayPublisher('  “Curly Press” ')).toBe('Curly Press');
  });

  it('leaves names that are not wrapped as a whole alone', () => {
    expect(displayPublisher('Plain Press')).toBe('Plain Press');
    expect(displayPublisher('"A" & "B"')).toBe('"A" & "B"');
    expect(displayPublisher('""')).toBe('""');
    expect(displayPublisher('"')).toBe('"');
  });

  it('treats a missing publisher as empty', () => {
    expect(displayPublisher(null)).toBe('');
    expect(displayPublisher(undefined)).toBe('');
  });
});
