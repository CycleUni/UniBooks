const fs = require('fs');
const path = require('path');

const envDir = path.join(__dirname, '../src/environments');

if (!fs.existsSync(envDir)) {
  fs.mkdirSync(envDir, { recursive: true });
}

// The app is served by the same Worker as the API (UniBooks/server), so the
// API is this origin's /api/v1 and chat is this origin's /api/chat. A relative
// default means a build needs no backend URL at all; NG_APP_BACKEND_URL is
// only for pointing a local build at some other API.
const backendUrl = process.env.NG_APP_BACKEND_URL || '/api/v1';

const envConfigFile = `
export const environment = {
  production: false,
  backendUrl: '${backendUrl}',
  gaMeasurementId: '${process.env.NG_APP_GA_MEASUREMENT_ID || ''}',
  sentryDsn: '${process.env.NG_APP_SENTRY_DSN || ''}',
  googleClientId: '${process.env.GOOGLE_CLIENT_ID || ''}'
};
`;

const prodConfigFile = `
export const environment = {
  production: true,
  backendUrl: '${backendUrl}',
  gaMeasurementId: '${process.env.NG_APP_GA_MEASUREMENT_ID || ''}',
  sentryDsn: '${process.env.NG_APP_SENTRY_DSN || ''}',
  googleClientId: '${process.env.GOOGLE_CLIENT_ID || ''}'
};
`;

function writeFile(filePath, content, label) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8' });
  console.log(`${label} generated at ${filePath}`);
}

// `--headers` is the post-build step (see package.json "build"): it only
// writes the CSP into the built _headers, below.
const HEADERS_ONLY = process.argv.includes('--headers');

if (!HEADERS_ONLY) {
  writeFile(path.join(envDir, 'environment.ts'), envConfigFile, 'environment.ts');
  writeFile(path.join(envDir, 'environment.prod.ts'), prodConfigFile, 'environment.prod.ts');
}

// Update angular.json allowedHosts if NG_APP_ALLOWED_HOSTS is provided
if (!HEADERS_ONLY && process.env.NG_APP_ALLOWED_HOSTS) {
  const angularJsonPath = path.join(__dirname, '../angular.json');
  try {
    let angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf8'));
    const hosts = process.env.NG_APP_ALLOWED_HOSTS.split(',').map(s => s.trim());
    const buildOptions = angularJson.projects['unibooks-fe'].architect.build.options;
    if (buildOptions.security) {
      buildOptions.security.allowedHosts = hosts;
      fs.writeFileSync(angularJsonPath, JSON.stringify(angularJson, null, 2), 'utf8');
      console.log(`Updated angular.json allowedHosts: ${hosts.join(', ')}`);
    }
  } catch (err) {
    console.error('Failed to update angular.json allowedHosts', err);
  }
}

// ---------------------------------------------------------------------------
// Content-Security-Policy
//
// The app, the API and chat share one origin (the UniBooks Worker serves all
// three), so connect-src is 'self' plus the third parties the app really
// talks to. The one origin a static file cannot know is the R2 public media
// domain (listing photos, avatars), which differs per deployment; the
// committed public/_headers therefore carries a Report-Only policy with
// img-src https: as its fallback.
//
// `node scripts/set-env.js --headers`, run after `ng build`, narrows that
// fallback in the *built* dist/.../_headers (public/_headers itself is never
// rewritten, so a deploy does not dirty the working tree). With R2_PUBLIC_URL
// set the img-src wildcard is replaced by that host, and NG_APP_CSP_ENFORCE=1
// additionally promotes the policy from Report-Only to enforcing. With
// R2_PUBLIC_URL unset the committed policy ships as it is — a deploy that does
// not opt in keeps working, with every other security header intact.
//
// R2_PUBLIC_URL deliberately carries no NG_APP_ prefix: it is the same value,
// in the same format, that the server Worker is configured with
// (server/wrangler.jsonc vars), so a whole KEY=VALUE line can be copied
// between the two. FRONTEND_URL keeps its historical unprefixed name but is
// the frontend's own now (the server derives everything from the request
// origin): the site's origin, used only to name its wss: origin below. The
// prefix is kept for the other frontend-only settings (NG_APP_BACKEND_URL;
// NG_APP_CSP_ENFORCE; NG_APP_GA_MEASUREMENT_ID).
// ---------------------------------------------------------------------------

/** The origin of an absolute http(s) URL; null for a relative one or none. */
function originOf(rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    console.warn(`[set-env] ignoring unparseable URL for CSP: ${rawUrl}`);
    return null;
  }
}

// Directives that cost nothing to enforce, whatever the deployment: the app
// has no <object>/<embed>, no cross-origin <form action>, its <base> is the
// origin itself, and X-Frame-Options: DENY already says what frame-ancestors
// says. Enforcing these needs no verification pass and no opt-in, so a deploy
// that never sets NG_APP_CSP_ENFORCE still gets real protection instead of a
// policy that only ever watches. base-uri in particular is worth having: a
// injected <base> tag is a standard way to escalate an HTML injection into
// script execution.
const ALWAYS_ENFORCED = [
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// The admin bulk import fetches its default lists from the CycleUni GitHub
// repositories (SchoolList's schools.<REGION>.json). The path keeps it to
// CycleUni's own files rather than everything raw.githubusercontent.com serves.
const IMPORT_LIST_SOURCE = 'https://raw.githubusercontent.com/CycleUni/';

// Firebase Cloud Messaging: the SDK registers the browser with these two hosts
// to get a push token (the messages themselves arrive over the browser's push
// service, which is not a page connection).
const FIREBASE_REGISTRATION = ['https://fcmregistrations.googleapis.com', 'https://firebaseinstallations.googleapis.com'];

// Sentry error reports and replays are POSTed to the project's ingest host.
const SENTRY_INGEST = 'https://*.ingest.us.sentry.io';

// Google Analytics 4: gtag.js (script-src googletagmanager.com) sends its hits
// to these hosts, by fetch/sendBeacon and as image pixels — Google's own CSP
// guidance for GA4. Without them an enforcing policy silently drops every hit.
const GA_CONNECT = ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com'];
const GA_IMG = ['https://*.google-analytics.com', 'https://*.googletagmanager.com'];

/**
 * 'self' covers the same-origin chat WebSocket (wss://<this host>/api/chat/...) under
 * CSP Level 3 (§6.7.2.8: 'self' matches a wss: URL on the page's host), but
 * not in every browser that is still about (MDN: "connect-src 'self' does not
 * resolve to websocket schemes in all browsers", webappsec-csp#7). So the
 * site's own wss: origin is named as well when FRONTEND_URL says what it is.
 * It is this origin, so it widens nothing.
 */
function siteSocketOrigin(rawUrl) {
  const origin = originOf(rawUrl);
  return origin ? origin.replace(/^http/, 'ws') : null;
}

function buildCsp({ backendOrigin, socketOrigin, mediaOrigin }) {
  const connect = ["'self'", socketOrigin, backendOrigin, 'https://accounts.google.com', IMPORT_LIST_SOURCE, ...FIREBASE_REGISTRATION, ...GA_CONNECT, SENTRY_INGEST];
  const img = ["'self'", 'data:', 'blob:', mediaOrigin || 'https:', 'https://lh3.googleusercontent.com', ...GA_IMG];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com https://www.googletagmanager.com https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src ${[...new Set(img.filter(Boolean))].join(' ')}`,
    `connect-src ${[...new Set(connect.filter(Boolean))].join(' ')}`,
    'frame-src https://accounts.google.com',
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

/** Replace the CSP block (one line or two) of a _headers file's text. */
function rewriteCsp(original, enforce, policy) {
  const headerName = enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
  const line = `  ${headerName}: ${policy}`;
  const lines = enforce
    // Enforcing the full policy supersedes the always-enforced subset.
    ? [line]
    : [`  Content-Security-Policy: ${ALWAYS_ENFORCED}`, line];
  let replaced = false;
  return original
    .split('\n')
    .flatMap(l => {
      if (!/^ {2}Content-Security-Policy(-Report-Only)?:/.test(l)) return [l];
      if (replaced) return [];
      replaced = true;
      return lines;
    })
    .join('\n');
}

if (HEADERS_ONLY) {
  const headersPath = path.join(__dirname, '../dist/unibooks-fe/browser/_headers');
  const mediaOrigin = originOf(process.env.R2_PUBLIC_URL);
  if (!fs.existsSync(headersPath)) {
    console.error(`[set-env] ${headersPath} not found — run after ng build`);
    process.exit(1);
  }
  const socketOrigin = siteSocketOrigin(process.env.FRONTEND_URL);
  if (!mediaOrigin && !socketOrigin) {
    console.log('CSP left as committed — set R2_PUBLIC_URL to narrow img-src (and NG_APP_CSP_ENFORCE=1 to enforce)');
  } else {
    // Enforcing still needs R2_PUBLIC_URL: without it img-src keeps its https:
    // fallback, which is a policy only worth watching. FRONTEND_URL alone just
    // adds the site's wss: origin to the committed (Report-Only) policy.
    const enforce = !!mediaOrigin && process.env.NG_APP_CSP_ENFORCE === '1';
    const original = fs.readFileSync(headersPath, 'utf8');
    const rewritten = rewriteCsp(original, enforce, buildCsp({
      backendOrigin: originOf(backendUrl),
      socketOrigin,
      mediaOrigin,
    }));
    fs.writeFileSync(headersPath, rewritten, { encoding: 'utf8' });
    console.log(`CSP written to ${path.relative(process.cwd(), headersPath)} (${enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'})`);
  }
}

