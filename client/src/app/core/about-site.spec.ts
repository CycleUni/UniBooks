import { aboutUrl } from './about-site';

describe('aboutUrl', () => {
  it('points at the UniBooks About site', () => {
    expect(aboutUrl('zh-TW')).toBe('https://unibooks.app/about/');
  });

  it('sends English readers to the English edition', () => {
    expect(aboutUrl('en')).toBe('https://unibooks.app/about/en/');
    expect(aboutUrl('en', 'about/terms')).toBe('https://unibooks.app/about/en/about/terms');
  });

  it('sends both Chinese languages to the Chinese pages, which have no zh-HK edition', () => {
    expect(aboutUrl('zh-TW', 'about/privacy')).toBe('https://unibooks.app/about/about/privacy');
    expect(aboutUrl('zh-HK', 'about/privacy')).toBe('https://unibooks.app/about/about/privacy');
  });
});
