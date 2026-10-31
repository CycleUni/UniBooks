import { Lang } from './i18n';

// The About site (guides, terms, privacy) is a separate VitePress site, served
// under /about/ by its own Worker through a Workers Route. Its
// Chinese pages sit at the root and its English ones under /en/; it has no
// zh-HK edition, so zh-HK readers get the Chinese pages.
const ABOUT_SITE = 'https://unibooks.app/about/';

export type AboutPage = '' | 'terms' | 'privacy';

export function aboutUrl(lang: Lang, page: AboutPage = ''): string {
  return ABOUT_SITE + (lang === 'en' ? 'en/' : '') + page;
}
