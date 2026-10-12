import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DEFAULT_REGION, REGION_TO_LANG, SUPPORTED_LANGS, type Lang } from '../src/app/core/i18n/index';


const SITE_NAME = 'UniBooks';
const DIST_DIR = path.join(__dirname, '../dist/unibooks-fe/browser');
const INDEX_HTML_PATH = path.join(DIST_DIR, 'index.html');
const REDIRECTS_PATH = path.join(DIST_DIR, '_redirects');
const NGSW_PATH = path.join(DIST_DIR, 'ngsw.json');
const SITEMAP_PATH = path.join(DIST_DIR, 'sitemap.xml');
/** esbuild's metafile, written by `ng build --stats-json` beside browser/. */
const STATS_PATH = path.join(DIST_DIR, '../stats.json');
const ENV_PROD_PATH = path.join(__dirname, '../src/environments/environment.prod.ts');
const SITE_ORIGIN = 'https://unibooks.app';
const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;


/**
 * The pages every region has and anyone can open, for the static sitemap.
 * Book and listing pages come and go with the data, so the backend serves
 * those (UniBooks-BE listings/sitemap.py); robots.txt names both files.
 * Anything behind a login, the auth flow, checkout and admin stay out.
 */
const SITEMAP_PAGES = ['', '/search', '/sell'];

/**
 * The i18n key each page's route declares as its `data.seo.titleKey`, so its
 * static file is titled as SeoService titles it. The home page uses
 * seo.homeTitle instead.
 */
const PAGE_TITLE_KEYS: Record<string, string> = {
  '/search': 'nav.search',
  '/sell': 'nav.sell',
};

/**
 * The page every other route of a region is rewritten to, served from
 * <region>/app-shell.html. The home page cannot double as this, as it once
 * did: it now names itself as canonical, which would be wrong on every route
 * the rewrite reaches. Rewrite targets name it without .html: the asset
 * server redirects a .html path to the bare one (html_handling
 * auto-trailing-slash), and does so for a rewrite's target too.
 */
const SHELL_PAGE = 'app-shell'; // server/src/services/frontend/bookMeta.ts REGION_SHELL
const I18N_DIR = path.resolve(__dirname, '../src/app/core/i18n');

type Strings = Record<string, string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadStrings(lang: Lang): Promise<Strings> {
  if (!SUPPORTED_LANGS.includes(lang)) {
    throw new Error(`Unsupported language configured for region: ${lang}`);
  }

  // Language codes are allowlisted above before they are used to form a path.
  const modulePath = path.resolve(I18N_DIR, `${lang}.ts`);
  if (!modulePath.startsWith(`${I18N_DIR}${path.sep}`)) {
    throw new Error(`Invalid translation module path for language: ${lang}`);
  }
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Translation file not found for language: ${lang}`);
  }

  const module = await import(modulePath) as Record<string, unknown>;
  const exportedStrings = Object.values(module).filter(
    (value): value is Strings =>
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === 'string'),
  );

  if (exportedStrings.length !== 1) {
    throw new Error(`Expected exactly one translation map in ${modulePath}`);
  }
  return exportedStrings[0];
}

/** The site's link-preview card (scripts/generate-icons.js). */
const OG_IMAGE_PATH = '/og-image.png';
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

function ogLocaleFor(lang: Lang): string {
  return lang === 'en' ? 'en_US' : lang.replace('-', '_');
}

function validateRegion(region: string): void {
  if (!/^[a-z0-9-]{1,16}$/.test(region)) {
    throw new Error(`Invalid region code configured: ${region}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A region page's URL. The region home carries its trailing slash because
 * the asset server redirects /tw to /tw/, and a canonical or hreflang target must not
 * redirect.
 */
function regionUrl(region: string, page: string): string {
  return page ? `${SITE_ORIGIN}/${region}${page}` : `${SITE_ORIGIN}/${region}/`;
}

/**
 * The origin every API request goes to, for a preconnect hint: the first
 * request only leaves once the app has booted, and on a phone the DNS, TCP
 * and TLS set-up it would otherwise start then is a few hundred
 * milliseconds. Taken from the env var set-env.js reads, else from the file
 * it wrote. Null when neither names a usable URL — the hint is only a hint.
 */
function apiOrigin(): string | null {
  let url = process.env['NG_APP_BACKEND_URL'];
  if (!url && fs.existsSync(ENV_PROD_PATH)) {
    url = /backendUrl:\s*'([^']*)'/.exec(fs.readFileSync(ENV_PROD_PATH, 'utf-8'))?.[1];
  }
  try {
    const origin = url ? new URL(url).origin : null;
    return origin && /^https?:/.test(origin) && origin !== SITE_ORIGIN ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Each language's translation chunk, by language. The app waits for its
 * language's table before it bootstraps (APP_INITIALIZER), and that import
 * only starts once main.js has run: one more round trip in series before
 * anything is on screen. The map goes into the page for theme-init.js, which
 * preloads the one the visitor's language needs so it downloads alongside
 * main.js instead. The language is the visitor's (stored choice, else the
 * browser's), not the region's, and the service worker serves one index.html
 * to every region — hence choosing it in the browser rather than here.
 *
 * Read off the build's metafile, the only place the hashed name is tied to
 * its source; an empty map (no stats file) leaves the pages without the
 * hint rather than failing the build.
 */
function languageChunks(): Partial<Record<Lang, string>> {
  if (!fs.existsSync(STATS_PATH)) {
    console.warn('stats.json not found; skipping the translation preload hint');
    return {};
  }
  const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8')) as {
    outputs?: Record<string, { entryPoint?: string }>;
  };
  const chunks: Partial<Record<Lang, string>> = {};
  for (const [file, output] of Object.entries(stats.outputs ?? {})) {
    const match = /^src\/app\/core\/i18n\/([\w-]+)\.ts$/.exec(output.entryPoint ?? '');
    const lang = match?.[1] as Lang | undefined;
    if (lang && SUPPORTED_LANGS.includes(lang) && /^[\w-]+\.js$/.test(file)) {
      chunks[lang] = file;
    }
  }
  return chunks;
}

/** Where the Chinese web fonts apply; see the stylesheet link in src/index.html. */
const CHINESE_FONTS_MEDIA = '(min-width: 901px)';

/**
 * Put the media query back on the inlined Chinese font faces. Angular's font
 * inlining turns the Google Fonts <link media=…> into a bare <style>, which
 * applies everywhere and sends phones to download the faces after all. A
 * <style media> keeps the inlining (no extra request on desktop) and the
 * restriction. Without inlining the link keeps its own attribute.
 */
function gateChineseFonts(html: string): string {
  const gated = html.replace(
    /<style>((?:(?!<\/style>)[\s\S])*?font-family:\s*'Noto S(?:ans|erif) TC'[\s\S]*?)<\/style>/g,
    `<style media="${CHINESE_FONTS_MEDIA}">$1</style>`,
  );
  if (/<style>(?:(?!<\/style>)[\s\S])*?font-family:\s*'Noto S(?:ans|erif) TC'/.test(gated)) {
    throw new Error('Chinese font faces left without their media query');
  }
  return gated;
}

function replaceRequired(html: string, pattern: RegExp, replacement: string, label: string): string {
  if (!pattern.test(html)) {
    throw new Error(`Could not find ${label} in index.html`);
  }
  return html.replace(pattern, replacement);
}

/**
 * Where a region page's static file goes. The home page is the directory
 * index (/tw/ is served from it); the others drop their .html, as the asset
 * server does, so /tw/search is served from tw/search.html with no redirect. Unlike
 * a non-HTML file, such a page does not win over the region's /tw/* rewrite
 * on its own; injectRedirects gives each one a rule of its own ahead of it.
 */
function pageFile(region: string, page: string): string {
  return path.join(DIST_DIR, region, page ? `${page.slice(1)}.html` : 'index.html');
}

/**
 * hreflang links naming a page's copy in every region: the set SeoService
 * writes in the browser, in the HTML for a crawler that does not run the app.
 */
function alternateTags(page: string): string[] {
  return [
    ...Object.entries(REGION_TO_LANG).map(([region, lang]) => ({ hreflang: lang, href: regionUrl(region, page) })),
    { hreflang: 'x-default', href: regionUrl(DEFAULT_REGION, page) },
  ].map((alt) => `<link rel="alternate" hreflang="${escapeHtml(alt.hreflang)}" href="${escapeHtml(alt.href)}">`);
}

/**
 * Rewrite title, description and inject og:* tags.
 * Pass `null` as region for the root index.html (og:url = https://unibooks.app).
 * `page` is the one page a region file is for ('' for its home), which gets
 * its own title, canonical and hreflang; `null` is the region's shell, served
 * for every other route, which can name none of them.
 */
function buildHtml(
  originalHtml: string,
  region: string | null,
  page: string | null,
  locale: Lang,
  strings: Strings,
  hints: { apiOrigin: string | null; languageChunks: Partial<Record<Lang, string>> },
): string {
  let html = gateChineseFonts(originalHtml);

  const pageName = page ? strings[PAGE_TITLE_KEYS[page]] : undefined;
  const title = pageName ? `${pageName} · ${SITE_NAME}` : strings['seo.homeTitle'] ?? SITE_NAME;
  const description = strings['seo.description'] ?? '';

  html = replaceRequired(
    html,
    /<html\b([^>]*)\blang=["'][^"']*["']([^>]*)>/i,
    `<html$1lang="${locale}"$2>`,
    'the root html language attribute',
  );

  // Replace <title>
  html = replaceRequired(
    html,
    /<title>.*?<\/title>/,
    `<title>${escapeHtml(title)}</title>`,
    'the title element',
  );

  // Replace <meta name="description" ...>
  html = replaceRequired(
    html,
    /<meta\s+name=["']description["'][^>]*>/i,
    `<meta name="description" content="${escapeHtml(description)}">`,
    'the description meta tag',
  );

  const ogUrl = region ? regionUrl(region, page ?? '') : `${SITE_ORIGIN}/`;
  // The 1200x630 card npm run icons draws; the square app icon stays the
  // Organization logo, which Google wants square.
  const ogImage = `${SITE_ORIGIN}${OG_IMAGE_PATH}`;
  const logo = `${SITE_ORIGIN}/icons/icon-512x512.png`;
  const ogLocale = ogLocaleFor(locale);

  // A region page's own file names itself as canonical and its copy in
  // every region as hreflang. SeoService writes the same links once the app
  // runs, which a crawler that does not run it never sees.
  //
  // No canonical or hreflang in a region's shell. It is served for every
  // other route of its region (the /<region>/* rewrite), so a link naming
  // any one page would be wrong on the rest, and a book page would carry two
  // canonicals once the server appends its own. SeoService writes both
  // for the route in the browser, and the server Worker's /<region>/book
  // route (server/src/routes/frontend.ts) at the edge.
  //
  // The root file does get a canonical, to the default region's home. "/"
  // has no page of its own: rootRedirectGuard forwards it in the browser,
  // which a crawler reading the HTML never sees, so the bare origin looked
  // like a second copy of /tw/. The other paths this file is served for are
  // the unprefixed ones (/listing/…, /verify?…), which the app also forwards
  // into a region, and whose canonical SeoService then replaces in place.
  // No hreflang: /tw/ and /hk/ do not name "/" back, so it would be ignored.
  const linkTags = !region
    ? [`<link rel="canonical" href="${escapeHtml(regionUrl(DEFAULT_REGION, ''))}">`]
    : page === null
      ? []
      : [`<link rel="canonical" href="${escapeHtml(ogUrl)}">`, ...alternateTags(page)];

  // Organization.logo is what Google shows beside the site in results.
  // A data block, not script, so the CSP's script-src does not apply.
  // The @id is shared with about.unibooks.app, whose pages name this
  // Organization as publisher, so both hosts resolve to one entity and the
  // brand query lands here rather than on the help site.
  const searchBase = region ? `${SITE_ORIGIN}/${region}` : `${SITE_ORIGIN}/${DEFAULT_REGION}`;
  const ldJson = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION_ID,
        "name": SITE_NAME,
        "url": `${SITE_ORIGIN}/`,
        "logo": logo,
        "description": description,
        "sameAs": ["https://github.com/CycleUni"]
      },
      {
        "@type": "WebSite",
        "name": SITE_NAME,
        "url": ogUrl,
        "publisher": { "@id": ORGANIZATION_ID },
        "potentialAction": {
          "@type": "SearchAction",
          "target": `${searchBase}/search?q={search_term_string}`,
          "query-input": "required name=search_term_string"
        }
      }
    ]
  };

  // Resource hints go first in <head>, ahead of the stylesheets and scripts
  // the browser would otherwise queue before reading them.
  const hintTags = [
    hints.apiOrigin ? `<link rel="preconnect" href="${escapeHtml(hints.apiOrigin)}" crossorigin>` : '',
    Object.keys(hints.languageChunks).length > 0
      ? `<meta name="unibooks-i18n-chunks" content="${escapeHtml(JSON.stringify(hints.languageChunks))}">`
      : '',
  ].filter(Boolean);
  if (hintTags.length > 0) {
    html = replaceRequired(html, /(<meta charset=[^>]*>)/i, `$1\n  ${hintTags.join('\n  ')}`, 'the charset meta tag');
  }

  const tags = [
    ...linkTags,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(ogUrl)}">`,
    `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`,
    `<meta property="og:image:alt" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:locale" content="${ogLocale}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    // "<" escaped so no string in the block can close the script element.
    `<script type="application/ld+json">${JSON.stringify(ldJson).replace(/</g, '\\u003c')}</script>`,
  ].filter(Boolean).join('\n  ');

  // Insert tags before </head>
  html = replaceRequired(html, /<\/head>/i, `  ${tags}\n</head>`, 'the closing head tag');
  return html;
}

function updateServiceWorkerHash(html: string): void {
  if (!fs.existsSync(NGSW_PATH)) {
    // A build without a service worker (the smoke configuration) has no
    // manifest to keep in step with the patched HTML. A missing manifest
    // beside the worker itself, though, means a broken production build.
    if (!fs.existsSync(path.join(DIST_DIR, 'ngsw-worker.js'))) return;
    throw new Error('ngsw.json not found after Angular build');
  }

  const manifest = JSON.parse(fs.readFileSync(NGSW_PATH, 'utf-8')) as {
    hashTable?: Record<string, string>;
  };
  if (!manifest.hashTable || typeof manifest.hashTable['/index.html'] !== 'string') {
    throw new Error('ngsw.json does not contain a hash for /index.html');
  }

  manifest.hashTable['/index.html'] = createHash('sha1').update(html).digest('hex');
  fs.writeFileSync(NGSW_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Inject region redirect rules into the dist copy of _redirects.
 *
 * The source public/_redirects only contains static rules. Region rules are
 * derived entirely from REGION_TO_LANG, so adding a region never requires
 * editing _redirects by hand.
 *
 * Idempotent: any existing region rules are stripped before re-injecting,
 * so running the build script twice never produces duplicate entries.
 *
 * Desired order in the final file:
 *   /index.html  /  200          ← already in source file (must stay first)
 *   /<region>  /<region>/  200   ← injected, one per region
 *   /<region>/<page>  /<region>/<page>  200    ← injected, one per page and region
 *   /<region>/*  /<region>/app-shell  200      ← injected, one per region
 *
 * Anything else falls to the SPA fallback, which is the Worker's
 * not_found_handling = "single-page-application" (server/wrangler.jsonc);
 * Workers ignores a `/*  /index.html  200` rule as an infinite loop.
 *
 * A page's rule rewrites it to itself: without it the region's /* rule would
 * answer the page with the shell, as the asset server applies it ahead of an
 * HTML file matched by its pretty URL (a non-HTML file, like robots.txt, wins
 * anyway).
 *
 * The region home's rule serves /tw as /tw/. The asset server otherwise
 * redirects /tw to the directory index, and the router writes the address
 * back as /tw once the app is up, so the URL a visitor copies and shares
 * always paid that redirect. Canonical and hreflang keep naming /tw/ (see
 * regionUrl).
 */
function injectRedirects(regions: string[]): void {
  if (!fs.existsSync(REDIRECTS_PATH)) {
    throw new Error('_redirects not found in dist');
  }

  const original = fs.readFileSync(REDIRECTS_PATH, 'utf-8');

  // Strip any previously injected region rules to ensure idempotency.
  const stripped = original.replace(
    /^\/[a-z0-9-]+(\/\S*)?\s+\/[a-z0-9-]+\/\S*\s+200\n?/gmi,
    '',
  );

  const regionLines = [
    ...regions.map((r) => `/${r}  /${r}/  200`),
    ...regions.flatMap((r) => SITEMAP_PAGES.map((page) => `/${r}${page || '/'}  /${r}${page || '/'}  200`)),
    ...regions.map((r) => `/${r}/*  /${r}/${SHELL_PAGE}  200`),
  ].join('\n');

  // Appended after the static rules; the SPA fallback is not a rule here.
  const updated = `${stripped.replace(/\n*$/, '')}\n${regionLines}\n`;

  fs.writeFileSync(REDIRECTS_PATH, updated);
  console.log(`Injected redirect rules for: ${regions.join(', ')}`);
}

/** Write dist/sitemap.xml with each region's fixed public pages. */
function writeSitemap(regions: string[]): void {
  // Only the region copies are listed: the bare-origin URLs just forward to
  // one of them. hreflang lives in each page's head rather than here: an
  // xhtml:link in the file makes Chrome render it as a web page instead of
  // its XML tree.
  const urls = regions.flatMap((region) =>
    SITEMAP_PAGES.map((page) => `  <url><loc>${regionUrl(region, page)}</loc></url>`),
  );
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
  fs.writeFileSync(SITEMAP_PATH, xml);
  console.log(`Wrote sitemap.xml (${urls.length} URLs)`);
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error('index.html not found at', INDEX_HTML_PATH);
    process.exit(1);
  }

  const originalHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
  const hints = { apiOrigin: apiOrigin(), languageChunks: languageChunks() };

  // Patch the root index.html in the default region's language: "/" never
  // renders a page of its own (rootRedirectGuard forwards it), and crawlers
  // that read it before the redirect ran were indexing an English copy.
  const defaultLanguage: Lang = REGION_TO_LANG[DEFAULT_REGION];
  const rootHtml = buildHtml(originalHtml, null, null, defaultLanguage, await loadStrings(defaultLanguage), hints);
  fs.writeFileSync(INDEX_HTML_PATH, rootHtml);
  updateServiceWorkerHash(rootHtml);
  console.log(`Patched root index.html (${defaultLanguage})`);

  // Generate each region's shell and its pages.
  const regions = Object.keys(REGION_TO_LANG);
  for (const [region, lang] of Object.entries(REGION_TO_LANG)) {
    validateRegion(region);
    const regionDir = path.join(DIST_DIR, region);
    if (!fs.existsSync(regionDir)) {
      fs.mkdirSync(regionDir, { recursive: true });
    }

    const strings = await loadStrings(lang);

    fs.writeFileSync(path.join(regionDir, `${SHELL_PAGE}.html`), buildHtml(originalHtml, region, null, lang, strings, hints));
    for (const page of SITEMAP_PAGES) {
      fs.writeFileSync(pageFile(region, page), buildHtml(originalHtml, region, page, lang, strings, hints));
    }
    console.log(`Generated ${region}/ shell and ${SITEMAP_PAGES.length} pages (${lang})`);
  }

  injectRedirects(regions);
  writeSitemap(regions);
}

run().catch((error: unknown) => {
  console.error('Failed to build regional HTML:', error);
  process.exitCode = 1;
});
