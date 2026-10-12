import { regionSwitchUrl } from './region-path';

describe('regionSwitchUrl', () => {
  it('keeps the query string the page is addressed by', () => {
    expect(regionSwitchUrl('/tw/book?isbn=9780000000001', 'hk')).toBe('/hk/book?isbn=9780000000001');
    expect(regionSwitchUrl('/tw/search?q=java&page=2', 'hk')).toBe('/hk/search?q=java&page=2');
  });

  it('drops local_cache, whose preview belongs to the region being left', () => {
    expect(regionSwitchUrl('/tw/book?local_cache=true&isbn=9780000000001', 'hk')).toBe('/hk/book?isbn=9780000000001');
    expect(regionSwitchUrl('/tw/book?local_cache=true', 'hk')).toBe('/hk/book');
  });

  it('keeps the fragment and escaped characters intact', () => {
    expect(regionSwitchUrl('/tw/search?q=a%20b#results', 'hk')).toBe('/hk/search?q=a%20b#results');
  });

  it('handles the region root and paths without a query', () => {
    expect(regionSwitchUrl('/tw', 'hk')).toBe('/hk');
    expect(regionSwitchUrl('/tw?ref=nav', 'hk')).toBe('/hk?ref=nav');
    expect(regionSwitchUrl('/tw/listing/0591ba9f-098f-4185-a585-5a352cb18ba1', 'hk')).toBe('/hk/listing/0591ba9f-098f-4185-a585-5a352cb18ba1');
  });
});
