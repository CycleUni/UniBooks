import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// public/_headers is the only place these are declared, and nothing else in
// the build would notice if a directive were dropped — Cloudflare just serves
// whatever the file says, and a missing header is silent.
const HEADERS_PATH = path.join(process.cwd(), 'public/_headers');
const source = fs.readFileSync(HEADERS_PATH, 'utf-8');

/** Header lines only: '#' comments carry the same words and would otherwise
 *  satisfy every assertion below without a header existing at all. */
const headerLines = source
  .split('\n')
  .filter(line => line.startsWith('  ') && !line.trimStart().startsWith('#'));

function headerValue(name: string): string | null {
  const hit = headerLines.find(line => line.trimStart().startsWith(`${name}:`));
  return hit ? hit.slice(hit.indexOf(':') + 1).trim() : null;
}

describe('public/_headers', () => {
  it('still sets the headers the app relies on', () => {
    // Each of these was added for a reason recorded in the file; a silent
    // regression here is the kind that is only noticed after an incident.
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
    expect(headerValue('X-Frame-Options')).toBe('DENY');
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerValue('Strict-Transport-Security')).toContain('max-age=');
    expect(headerValue('Permissions-Policy')).toContain('camera=');
  });

  it('caches only content-hashed files for a year, never the pages', () => {
    // Rules are "/path" lines followed by indented headers; collect which
    // paths carry a long max-age.
    const longCached: string[] = [];
    let rule = '';
    for (const line of source.split('\n')) {
      if (line.startsWith('/')) rule = line.trim();
      else if (/^\s+Cache-Control:.*max-age=(\d{5,})/.test(line)) longCached.push(rule);
    }
    // /* would also match every SPA route, all served as index.html.
    expect(longCached).not.toContain('/*');
    expect(longCached.sort()).toEqual(['/chunk-*.js', '/main-*.js', '/polyfills-*.js', '/styles-*.css']);
  });

  describe('Content-Security-Policy', () => {
    // Committed state is Report-Only; scripts/set-env.js rewrites this line at
    // build time and can promote it to enforcing. Either name is valid here —
    // what matters is that a policy exists and says the right things.
    const csp =
      headerValue('Content-Security-Policy-Report-Only') ??
      headerValue('Content-Security-Policy');

    const directive = (name: string) =>
      (csp ?? '')
        .split(';')
        .map(part => part.trim())
        .find(part => part === name || part.startsWith(`${name} `)) ?? null;

    it('is present', () => {
      expect(csp).not.toBeNull();
    });

    it('enforces the directives that cost nothing to enforce', () => {
      // Holds in both states: by default an enforcing header carries just
      // this subset alongside the Report-Only full policy, and with
      // NG_APP_CSP_ENFORCE=1 the single enforcing header contains them too.
      // Without this assertion the enforcing line could be dropped entirely
      // and every other test here would still pass against the Report-Only
      // one — which is to say, the app would ship watching and not enforcing.
      const enforced = headerValue('Content-Security-Policy');
      expect(enforced).not.toBeNull();
      for (const required of [
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ]) {
        expect(enforced).toContain(required);
      }
    });

    it('keeps the directives that do not depend on the deployment', () => {
      expect(directive('default-src')).toBe("default-src 'self'");
      expect(directive('object-src')).toBe("object-src 'none'");
      expect(directive('base-uri')).toBe("base-uri 'self'");
      expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
      expect(directive('form-action')).toBe("form-action 'self'");
    });

    it("never allows 'unsafe-eval', and no inline script", () => {
      // 'unsafe-inline' in style-src is a known, documented concession for
      // Angular's component styles. Script is a different matter: allowing it
      // there would defeat the point of having a policy at all.
      expect(csp).not.toContain("'unsafe-eval'");
      expect(directive('script-src')).not.toContain("'unsafe-inline'");
    });

    it('allows the Google Identity Services stylesheet', () => {
      // GSI injects <link href="https://accounts.google.com/gsi/style">; with
      // style-src naming only Google Fonts every sign-in page logged a
      // violation, and enforcing would unstyle the button.
      expect(directive('style-src')).toContain('https://accounts.google.com/gsi/style');
      // set-env.js rebuilds this line on real deployments and must agree.
      const setEnv = fs.readFileSync(path.join(process.cwd(), 'scripts/set-env.js'), 'utf-8');
      expect(setEnv).toMatch(/"style-src [^"]*https:\/\/accounts\.google\.com\/gsi\/style[^"]*"/);
    });

    it('lets the admin import fetch the CycleUni lists', () => {
      // The school import fills in raw.githubusercontent.com/CycleUni/SchoolList/...;
      // with connect-src naming only the API, the browser blocked it before
      // any request left. set-env.js rebuilds this line on real deployments.
      const setEnv = fs.readFileSync(path.join(process.cwd(), 'scripts/set-env.js'), 'utf-8');
      expect(setEnv).toContain("const IMPORT_LIST_SOURCE = 'https://raw.githubusercontent.com/CycleUni/';");
      expect(setEnv).toMatch(/const connect = \[[^\]]*IMPORT_LIST_SOURCE/);
    });

    it("covers the same-origin chat WebSocket with 'self'", () => {
      // Chat is wss://<this host>/api/chat/…; CSP3 'self' matches it.
      const setEnv = fs.readFileSync(path.join(process.cwd(), 'scripts/set-env.js'), 'utf-8');
      expect(setEnv).toMatch(/const connect = \["'self'",/);
      expect(setEnv).not.toContain('FRONTEND_URL');
      expect(directive('connect-src')).toContain("'self'");
    });

    it("lets Sentry post error reports to this project's ingest host only", () => {
      const setEnv = fs.readFileSync(path.join(process.cwd(), 'scripts/set-env.js'), 'utf-8');
      expect(setEnv).toContain('const SENTRY_INGEST = originOf(process.env.SENTRY_DSN);');
      expect(setEnv).toMatch(/const connect = \[[^\]]*SENTRY_INGEST\]/);
      expect(setEnv).not.toContain('*.ingest.us.sentry.io');
    });

    it('allows Google Analytics by its gtag path, not the whole Tag Manager host', () => {
      const setEnv = fs.readFileSync(path.join(process.cwd(), 'scripts/set-env.js'), 'utf-8');
      expect(setEnv).toContain('https://www.googletagmanager.com/gtag/ ');
      expect(directive('script-src')).not.toMatch(/https:\/\/www\.googletagmanager\.com(\s|$)/);
    });

    it('does not let a wildcard reach script-src', () => {
      // img-src/connect-src carry wildcards in the committed fallback (see the
      // file's comment); script-src must never be among them, in any state.
      expect(directive('script-src')).not.toMatch(/(^|\s)(\*|https:)(\s|$)/);
    });
  });

  describe('admin console CSP exception', () => {
    // The ad form previews foreign image URLs, so the console's pages carry
    // the site-wide policy with only img-src opened to https:.
    const rules = source.split(/\n(?=\/)/).filter(r => /^\/:region\/admin(\/\*)?\n/.test(r));

    it('has a rule for the console root and everything below it', () => {
      expect(rules.map(r => r.split('\n')[0])).toEqual(['/:region/admin', '/:region/admin/*']);
    });

    it('uses at most one splat per rule: Workers drops a rule with two', () => {
      for (const r of rules) expect((r.split('\n')[0].match(/\*/g) ?? []).length).toBeLessThanOrEqual(1);
    });

    it('detaches the site-wide CSP first, since two CSP headers both apply', () => {
      for (const r of rules) {
        expect(r).toContain('  ! Content-Security-Policy\n');
        expect(r).toContain('  ! Content-Security-Policy-Report-Only\n');
      }
    });

    it('differs from the site-wide policy in img-src only', () => {
      const siteWide = headerValue('Content-Security-Policy-Report-Only')!;
      const strip = (p: string) => p.replace(/img-src [^;]*/, '');
      for (const r of rules) {
        const line = r.split('\n').find(l => l.trimStart().startsWith('Content-Security-Policy-Report-Only:'))!;
        const policy = line.slice(line.indexOf(':') + 1).trim();
        expect(strip(policy)).toBe(strip(siteWide));
        expect(policy).toContain("img-src 'self' data: blob: https:");
        expect(policy).not.toMatch(/script-src[^;]*https:(\s|;|$)/);
      }
    });
  });

  describe('what the built page needs from the policy', () => {
    // script-src has no 'unsafe-inline', so anything inline in the shell is a
    // violation today and a broken page the day the policy is enforced.
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src/index.html'), 'utf-8')
      .replace(/<!--[\s\S]*?-->/g, '');

    it('ships no inline script in index.html', () => {
      const scripts = indexHtml.match(/<script\b[^>]*>/gi) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) {
        expect(tag).toMatch(/\ssrc=/);
      }
    });

    it('ships no inline event handler attributes in index.html', () => {
      expect(indexHtml).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    });

    it('keeps the pre-paint theme script as a file the policy allows', () => {
      expect(fs.existsSync(path.join(process.cwd(), 'public/theme-init.js'))).toBe(true);
      // Absolute, like every other asset reference: on a deep URL the
      // browser's preload scanner resolves a relative one against the path
      // instead of <base>, and fetches /tw/theme-init.js.
      expect(indexHtml).toContain('<script src="/theme-init.js"></script>');
    });

    it("does not let the build add an onload handler to the stylesheet link", () => {
      // Critical-CSS inlining (Beasties) rewrites the stylesheet to
      // <link media="print" onload="this.media='all'"> — an inline handler
      // added after index.html, so only the build config can prevent it.
      const angular = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'angular.json'), 'utf-8'));
      const configs = angular.projects['unibooks'].architect.build.configurations;
      for (const name of ['production', 'smoke']) {
        expect(configs[name].optimization?.styles?.inlineCritical).toBe(false);
      }
    });
  });
});
