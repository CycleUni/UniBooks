// Applies the saved theme choice before first paint so there's no flash
// of the wrong theme while Angular boots. Mirrors ThemeService's own
// logic/storage key (src/app/core/services/theme.service.ts) — keep
// both in sync if that key or the light/dark values ever change.
//
// Also tags <html> with the "js" class so index.html can hide its
// crawler-only summary inside <app-root>; without it that summary flashed
// on screen for the moment before Angular booted and replaced it.
//
// And starts the download of the visitor's translation table: the app
// imports it before it bootstraps, which otherwise only begins once main.js
// has run. The chunk names come from a meta tag the build writes
// (scripts/build-region-html.ts); the language choice mirrors I18nService's
// initialLang() and langFromBrowserTag() (src/app/core/i18n.service.ts) —
// i18n-preload.spec.ts holds the two to the same answers.
//
// Served as its own file rather than inline in index.html so the
// Content-Security-Policy can keep script-src to 'self'.
(function () {
  document.documentElement.classList.add('js');
  try {
    var stored = localStorage.getItem('unibooks_theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}

  try {
    var meta = document.querySelector('meta[name="unibooks-i18n-chunks"]');
    var chunks = meta ? JSON.parse(meta.getAttribute('content') || '{}') : {};
    var lang = null;
    try {
      lang = localStorage.getItem('lang');
    } catch (e) {}
    if (lang !== 'en' && lang !== 'zh-TW' && lang !== 'zh-HK') {
      var region = (location.pathname.split('/')[1] || '').toLowerCase();
      lang = region === 'tw' ? 'zh-TW' : region === 'hk' ? 'zh-HK' : null;
    }
    if (lang !== 'en' && lang !== 'zh-TW' && lang !== 'zh-HK') {
      var tag = (navigator.language || '').toLowerCase().replace(/_/g, '-');
      if (tag.indexOf('yue') === 0) lang = 'zh-HK';
      else if (tag.indexOf('zh') === 0) lang = tag.indexOf('hk') !== -1 || tag.indexOf('yue') !== -1 ? 'zh-HK' : 'zh-TW';
      else lang = 'en';
    }
    var file = chunks[lang];
    if (typeof file === 'string' && /^[\w-]+\.js$/.test(file)) {
      var link = document.createElement('link');
      link.rel = 'modulepreload';
      link.href = '/' + file;
      document.head.appendChild(link);
    }
  } catch (e) {}
})();
