import { aboutUrl } from './about-site';

describe('aboutUrl', () => {
  it('points at the UniBooks About site', () => {
    expect(aboutUrl('zh-TW')).toBe('https://unibooks.app/about/');
  });

  it('sends English readers to the English edition', () => {
    expect(aboutUrl('en')).toBe('https://unibooks.app/about/en/');
    expect(aboutUrl('en', 'terms')).toBe('https://unibooks.app/about/en/terms');
  });

  it('sends both Chinese languages to the Chinese pages, which have no zh-HK edition', () => {
    expect(aboutUrl('zh-TW', 'privacy')).toBe('https://unibooks.app/about/privacy');
    expect(aboutUrl('zh-HK', 'privacy')).toBe('https://unibooks.app/about/privacy');
  });
});
