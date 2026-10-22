import { SearchSnapshot, SearchSnapshotState } from './search-snapshot';

describe('SearchSnapshot', () => {
  const state = (over: Partial<SearchSnapshotState> = {}): SearchSnapshotState => ({
    fetchKey: 'k', results: [{ id: 1 }], totalCount: 40, localCount: null, searchScope: null, searchCity: null,
    cityCount: 0, googleUnavailable: false, resultsTruncated: false, loadedPage: 2, scrollY: 900, at: 1_000, ...over,
  });

  it('gives back the snapshot for the same search, once', () => {
    const s = new SearchSnapshot();
    s.save(state());
    expect(s.take('k', 2_000)?.loadedPage).toBe(2);
    expect(s.take('k', 2_000)).toBeNull();
  });

  it('refuses another search or an old snapshot', () => {
    const s = new SearchSnapshot();
    s.save(state());
    expect(s.take('other', 2_000)).toBeNull();
    s.save(state());
    expect(s.take('k', 1_000 + 11 * 60_000)).toBeNull();
  });
});
