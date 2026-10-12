import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, NavigationEnd, ResolveStart, Router } from '@angular/router';
import { I18nService } from '../i18n.service';
import { DEFAULT_REGION, REGION_TO_LANG } from '../i18n';

/**
 * What a page says about itself to the tab, to search engines and to link
 * previews. Every field is optional; whatever is left out falls back to the
 * route's `data.seo`, then to the site-wide defaults.
 */
export interface PageSeo {
  /** i18n key for the page name; resolved on every language change. */
  titleKey?: string;
  titleParams?: Record<string, string | number>;
  /** A page name that is data rather than copy (a book's title). Wins over titleKey. */
  title?: string;
  descriptionKey?: string;
  descriptionParams?: Record<string, string | number>;
  /** Region-prefixed path plus the query that identifies the page, e.g.
   *  `/tw/book?isbn=9781449319793`. Defaults to the current path with no query. */
  canonicalPath?: string;
  /** Absolute or root-relative image URL for og:image. Defaults to the
   *  site's 1200x630 card. */
  image?: string;
  noindex?: boolean;
}

export const SITE_NAME = 'UniBooks';

/**
 * Owns <title>, the meta description, the canonical link and the og:/twitter:
 * tags for the whole app.
 *
 * Every page used to share one title — App set `seo.title` once — so every
 * tab, bookmark and search result read "UniBooks". Pages now describe
 * themselves in two layers: routes declare a static `data.seo`, and a page
 * whose name comes from data (a book, a search term) calls setPage() once it
 * knows it.
 *
 * The page layer is cleared on ResolveStart rather than NavigationStart:
 * that event only fires once guards have let the navigation through, so a
 * navigation a guard cancels (unsaved changes on /sell) leaves the page it
 * stayed on described as it was. A reused component re-emits its query
 * params during activation, which is after this point, so a search for a
 * new term re-titles itself rather than being wiped.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private title = inject(Title);
  private meta = inject(Meta);
  private router = inject(Router);
  private i18n = inject(I18nService);
  private document = inject(DOCUMENT);

  private routeSeo = signal<PageSeo>({});
  private pageSeo = signal<PageSeo>({});
  private path = signal('/');

  constructor() {
    this.router.events.subscribe(event => {
      if (event instanceof ResolveStart) {
        this.pageSeo.set({});
      } else if (event instanceof NavigationEnd) {
        this.routeSeo.set(deepestSeo(this.router.routerState.snapshot.root));
        this.path.set(event.urlAfterRedirects.split(/[?#]/)[0]);
      }
    });

    effect(() => {
      this.i18n.lang();
      this.render({ ...this.routeSeo(), ...this.pageSeo() }, this.path());
    });
  }

  /**
   * The current page's own name, without the site suffix ("Sample Book 1",
   * not "Sample Book 1 · UniBooks"); '' where the page has none. The mobile
   * app bar shows it as the screen title, so every page that sets its SEO
   * title gets one without doing anything else.
   */
  readonly pageName = computed(() => {
    this.i18n.lang();
    const seo = { ...this.routeSeo(), ...this.pageSeo() };
    return seo.title || (seo.titleKey ? this.i18n.t(seo.titleKey, seo.titleParams) : '');
  });

  /** Describe the page currently shown. Replaces any earlier call for it. */
  setPage(seo: PageSeo): void {
    this.pageSeo.set(seo);
  }

  private render(seo: PageSeo, path: string): void {
    const pageName = seo.title || (seo.titleKey ? this.i18n.t(seo.titleKey, seo.titleParams) : '');
    const fullTitle = pageName ? `${pageName} · ${SITE_NAME}` : this.i18n.t('seo.homeTitle');
    const description = seo.descriptionKey
      ? this.i18n.t(seo.descriptionKey, seo.descriptionParams)
      : this.i18n.t('seo.description');
    const origin = this.document.location?.origin ?? '';
    let canonicalPath = seo.canonicalPath || path;
    // A region home is served at /tw/; Pages 308s /tw there, and a canonical
    // must not point at a redirect.
    if (/^\/[a-z]{2}$/.test(canonicalPath)) canonicalPath += '/';
    const canonical = origin + canonicalPath;

    this.title.setTitle(fullTitle);
    this.meta.updateTag({ name: 'description', content: description });

    this.setCanonical(canonical);

    this.meta.updateTag({ property: 'og:site_name', content: SITE_NAME });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:title', content: fullTitle });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:url', content: canonical });
    // The same card scripts/build-region-html.ts writes into the HTML, so a
    // page without an image of its own does not drop the preview picture.
    const image = new URL(seo.image || '/og-image.png', origin || undefined).toString();
    this.meta.updateTag({ property: 'og:image', content: image });
    this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });
    if (seo.image) {
      // A page's own image (a book cover) has a size of its own, which the
      // card's width and height would misdescribe.
      this.meta.removeTag('property="og:image:width"');
      this.meta.removeTag('property="og:image:height"');
      this.meta.removeTag('property="og:image:alt"');
    } else {
      this.meta.updateTag({ property: 'og:image:width', content: '1200' });
      this.meta.updateTag({ property: 'og:image:height', content: '630' });
      this.meta.updateTag({ property: 'og:image:alt', content: SITE_NAME });
    }

    if (seo.noindex) {
      this.meta.updateTag({ name: 'robots', content: 'noindex' });
    } else {
      this.meta.removeTag('name="robots"');
    }
  }

  private setCanonical(href: string): void {
    const head = this.document.head;
    if (!head) return;
    let link = head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      head.appendChild(link);
    }
    link.setAttribute('href', href);
    this.setAlternates(new URL(href, this.document.location?.href || 'http://localhost/'));
  }

  /**
   * hreflang links naming this page's copy in every region, so a search
   * engine can send each visitor to the one in their language. x-default is
   * the default region's copy, so every link in the set points both ways.
   */
  private setAlternates(url: URL): void {
    const head = this.document.head;
    head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());

    const [, first, ...rest] = url.pathname.split('/');
    if (!(first in REGION_TO_LANG)) return;
    const page = rest.length && rest.join('/') ? `/${rest.join('/')}` : '';
    // The region home keeps its slash: Pages redirects /tw to /tw/.
    const hrefFor = (region: string) => `${url.origin}/${region}${page || '/'}`;
    const alternates = [
      ...Object.entries(REGION_TO_LANG).map(([region, lang]) => ({ hreflang: lang, href: hrefFor(region) })),
      { hreflang: 'x-default', href: hrefFor(DEFAULT_REGION) },
    ];
    for (const alt of alternates) {
      const el = this.document.createElement('link');
      el.setAttribute('rel', 'alternate');
      el.setAttribute('hreflang', alt.hreflang);
      el.setAttribute('href', alt.href + url.search);
      head.appendChild(el);
    }
  }
}

/** The `data.seo` of the most specific route that declares one. */
function deepestSeo(snapshot: ActivatedRouteSnapshot): PageSeo {
  let found: PageSeo = {};
  let node: ActivatedRouteSnapshot | null = snapshot;
  while (node) {
    const seo = node.routeConfig?.data?.['seo'] as PageSeo | undefined;
    if (seo) found = seo;
    node = node.firstChild;
  }
  return found;
}
