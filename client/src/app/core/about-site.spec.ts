import { aboutUrl } from './about-site';

describe('aboutUrl', () => {
  it('points at the UniBooks About site', () => {
    expect(aboutUrl('zh-TW')).toBe('https://about.unibooks.app/');
  });

  it('sends English readers to the English edition', () => {
    expect(aboutUrl('en')).toBe('https://about.unibooks.app/en/');
    expect(aboutUrl('en', 'about/terms')).toBe('https://about.unibooks.app/en/about/terms');
  });

  it('sends both Chinese languages to the Chinese pages, which have no zh-HK edition', () => {
    expect(aboutUrl('zh-TW', 'about/privacy')).toBe('https://about.unibooks.app/about/privacy');
    expect(aboutUrl('zh-HK', 'about/privacy')).toBe('https://about.unibooks.app/about/privacy');
  });
});
