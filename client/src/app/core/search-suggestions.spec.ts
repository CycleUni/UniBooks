import { RecentSearches } from './search-suggestions';

describe('RecentSearches', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the newest first, without duplicates, and survives a reload', () => {
    const recent = new RecentSearches();
    recent.add('calculus');
    recent.add('Economics');
    recent.add('Calculus ');
    expect(recent.items()).toEqual(['Calculus', 'Economics']);
    expect(new RecentSearches().items()).toEqual(['Calculus', 'Economics']);
  });

  it('keeps at most five and ignores blank queries', () => {
    const recent = new RecentSearches();
    for (let i = 1; i <= 10; i++) recent.add(`q${i}`);
    recent.add('   ');
    expect(recent.items().length).toBe(5);
    expect(recent.items()[0]).toBe('q10');
  });

  it('removes one or all', () => {
    const recent = new RecentSearches();
    recent.add('a');
    recent.add('b');
    recent.remove('a');
    expect(recent.items()).toEqual(['b']);
    recent.clear();
    expect(recent.items()).toEqual([]);
    expect(localStorage.getItem('unibooks.search.recent')).toBeNull();
  });
});
