import { keywordsMatch, schoolKeywords } from './school-search';

describe('schoolKeywords', () => {
  it('lists every name, the code and the domain once each', () => {
    expect(schoolKeywords({
      name: 'National Taiwan University',
      display_name: '國立臺灣大學',
      names: ['National Taiwan University', '國立臺灣大學'],
      code: 'NTU',
      email_domain: 'ntu.edu.tw',
    })).toEqual(['國立臺灣大學', 'National Taiwan University', 'NTU', 'ntu.edu.tw']);
  });

  it('reads the names out of admin API translations', () => {
    expect(schoolKeywords({
      name: 'The University of Hong Kong',
      translations: { 'zh-HK': { name: '香港大學' }, broken: null },
    })).toEqual(['The University of Hong Kong', '香港大學']);
  });
});

describe('keywordsMatch', () => {
  it('matches case-insensitively against a lowercased query', () => {
    expect(keywordsMatch(['NTU', '國立臺灣大學'], 'ntu')).toBe(true);
    expect(keywordsMatch(['NTU', '國立臺灣大學'], '臺灣')).toBe(true);
    expect(keywordsMatch(['NTU'], 'nccu')).toBe(false);
    expect(keywordsMatch(undefined, 'ntu')).toBe(false);
  });
});
