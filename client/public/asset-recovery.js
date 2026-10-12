// Heals a browser whose HTTP cache holds HTML under a hashed script's URL.
//
// A request for a hashed build file the deployment does not have (yet, at
// that edge, or any more) is answered by the SPA fallback with index.html —
// carrying the year-long immutable cache public/_headers sets for those
// names. A browser that gets one keeps it: every reload fails with "Expected
// a JavaScript module script but the server responded with text/html", the
// app never boots, and so none of its own recovery (src/app/app.ts) can run.
// Only a script that loads before the bundles can reach it.
//
// A classic script, loaded before the module bundles and listening in the
// capture phase, because a failed <script>/<link> does not bubble its error.
// On a hashed main/polyfills/styles failure it refetches that file with
// cache: 'reload' — which replaces the stored response — and, for a script,
// every hashed file it statically imports (a poisoned chunk fails the whole
// module graph, but the error is reported on main). Then it reloads, once per
// thirty seconds, so an asset that is broken on the server cannot loop.
//
// Served as its own file, not inline, so the CSP can keep script-src 'self'.
// The name pattern matches the hashed rules in public/_headers.
(function () {
  var HASHED = /\/(main|polyfills|chunk|styles)-[A-Za-z0-9_-]+\.(js|css)$/;
  var STATIC_IMPORT = /(?:from|import)\s*["'](\.\/(?:main|polyfills|chunk)-[A-Za-z0-9_-]+\.js)["']/g;
  var GUARD_KEY = 'unibooks.assetRecovery';
  var GUARD_MS = 30000;
  var MAX_FILES = 100;
  var running = false;

  function refresh(url, seen) {
    if (seen[url] || Object.keys(seen).length >= MAX_FILES) return Promise.resolve();
    seen[url] = true;
    return fetch(url, { cache: 'reload' }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (!/javascript/.test(type)) return;
      return res.text().then(function (source) {
        var imports = [];
        var match;
        STATIC_IMPORT.lastIndex = 0;
        while ((match = STATIC_IMPORT.exec(source))) {
          imports.push(refresh(new URL(match[1], url).href, seen));
        }
        return Promise.all(imports);
      });
    });
  }

  window.addEventListener('error', function (event) {
    var el = event.target;
    var url = el && (el.tagName === 'SCRIPT' ? el.src : el.tagName === 'LINK' ? el.href : '');
    if (!url || running) return;
    try {
      if (!HASHED.test(new URL(url).pathname)) return;
      var last = Number(sessionStorage.getItem(GUARD_KEY));
      if (last && Date.now() - last < GUARD_MS) return;
      sessionStorage.setItem(GUARD_KEY, String(Date.now()));
    } catch (e) {
      // No sessionStorage means no loop guard: leave the page as it is.
      return;
    }
    running = true;
    refresh(url, {}).then(
      function () { location.reload(); },
      function () { running = false; }
    );
  }, true);
})();
