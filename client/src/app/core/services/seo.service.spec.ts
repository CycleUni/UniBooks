import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { I18nService } from '../i18n.service';
import { SeoService } from './seo.service';

@Component({ template: '' })
class PlainPage {}

/** Stands in for Book/Search: names itself once it has data. */
@Component({ template: '' })
class DataPage {
  constructor() {
    inject(SeoService).setPage({
      title: 'Python for Data Analysis',
      canonicalPath: '/tw/book?isbn=9781449319793',
      image: '/api/cover?src=x',
    });
  }
}

describe('SeoService', () => {
  let harness: RouterTestingHarness;
  let i18n: I18nService;

  const head = () => document.head;
  const meta = (selector: string) => head().querySelector<HTMLMetaElement>(`meta[${selector}]`)?.content ?? null;
  const canonical = () => head().querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href') ?? null;

  beforeEach(async () => {
    localStorage.setItem('lang', 'en');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'tw', component: PlainPage },
          { path: 'tw/search', component: PlainPage, data: { seo: { titleKey: 'nav.search' } } },
          { path: 'tw/book', component: DataPage },
          { path: '**', component: PlainPage, data: { seo: { titleKey: 'notfound.title', noindex: true } } },
        ]),
      ],
    });
    i18n = TestBed.inject(I18nService);
    TestBed.inject(SeoService);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    localStorage.removeItem('lang');
    head().querySelectorAll('link[rel="canonical"], link[rel="alternate"], meta[name="robots"], meta[property^="og:"], meta[name^="twitter:"]')
      .forEach(el => el.remove());
  });

  async function visit(url: string) {
    await harness.navigateByUrl(url);
    TestBed.tick();
  }

  it('titles a page from its route data, and the home page from the site title', async () => {
    await visit('/tw/search');
    expect(document.title).toBe('Find Books · UniBooks');

    await visit('/tw');
    expect(document.title).toBe('UniBooks - Campus Marketplace');
  });

  it('lets a page name itself, and forgets that name on the next page', async () => {
    await visit('/tw/book?isbn=9781449319793&engine=googlebooks');
    expect(document.title).toBe('Python for Data Analysis · UniBooks');
    expect(meta('property="og:title"')).toBe('Python for Data Analysis · UniBooks');
    expect(canonical()).toBe(`${location.origin}/tw/book?isbn=9781449319793`);
    expect(meta('property="og:image"')).toBe(`${location.origin}/api/cover?src=x`);
    expect(meta('name="twitter:card"')).toBe('summary_large_image');
    expect(meta('property="og:image:width"')).toBeNull();

    await visit('/tw/search?q=java');
    expect(document.title).toBe('Find Books · UniBooks');
    expect(meta('property="og:image"')).toBe(`${location.origin}/og-image.png`);
    expect(meta('property="og:image:width"')).toBe('1200');
    expect(meta('name="twitter:card"')).toBe('summary_large_image');
  });

  it('points the canonical at the path without its query by default', async () => {
    await visit('/tw/search?q=java&page=2#top');
    expect(canonical()).toBe(`${location.origin}/tw/search`);
    expect(meta('property="og:url"')).toBe(`${location.origin}/tw/search`);
    expect(head().querySelectorAll('link[rel="canonical"]').length).toBe(1);
  });

  it('names each region copy of the page as an hreflang alternate, the default region as x-default', async () => {
    const alternates = () => [...head().querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]')]
      .map(el => [el.getAttribute('hreflang'), el.getAttribute('href')]);

    await visit('/tw/book?isbn=9781449319793');
    expect(alternates()).toEqual([
      ['zh-TW', `${location.origin}/tw/book?isbn=9781449319793`],
      ['zh-HK', `${location.origin}/hk/book?isbn=9781449319793`],
      ['x-default', `${location.origin}/tw/book?isbn=9781449319793`],
    ]);

    await visit('/tw');
    expect(canonical()).toBe(`${location.origin}/tw/`);
    expect(alternates()).toEqual([
      ['zh-TW', `${location.origin}/tw/`],
      ['zh-HK', `${location.origin}/hk/`],
      ['x-default', `${location.origin}/tw/`],
    ]);
  });

  it('marks the not-found page noindex, and only that page', async () => {
    await visit('/tw/this-page-does-not-exist');
    expect(meta('name="robots"')).toBe('noindex');
    expect(document.title).toBe('Page Not Found · UniBooks');

    await visit('/tw/search');
    expect(meta('name="robots"')).toBeNull();
  });

  it('always sets a description', async () => {
    await visit('/tw/search');
    expect(meta('name="description"')).toBe(i18n.t('seo.description'));
  });

  it('re-renders in the new language', async () => {
    await visit('/tw/search');
    await i18n.setLang('zh-TW');
    TestBed.tick();
    expect(document.title).toBe(`${i18n.t('nav.search')} · UniBooks`);
    expect(document.title).not.toContain('Find Books');
  });

  it('keeps a page name that is set during a cancelled navigation', async () => {
    // A guard that refuses the navigation must leave the current page's own
    // title in place: the page is still the one on screen.
    await visit('/tw/book?isbn=9781449319793');
    const router = TestBed.inject(Router);
    router.resetConfig([
      ...router.config.map(r => r.path === 'tw/search' ? { ...r, canActivate: [() => false] } : r),
    ]);
    await visit('/tw/search');
    expect(document.title).toBe('Python for Data Analysis · UniBooks');
  });
});
