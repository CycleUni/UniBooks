const fs = require('fs');
const path = require('path');

const envDir = path.join(__dirname, '../src/environments');

// ---------------------------------------------------------------------------
// Settings shared with the server Worker have ONE source: server/wrangler.jsonc
// "vars" (the production values). Local builds and tests (`npm start`,
// `npm test`, without --production) overlay server/.dev.vars, the same file
// `wrangler dev` reads. A variable already set in the environment (CI) wins.
// Only public values are read; secrets never reach this bundle.
// ---------------------------------------------------------------------------
const SHARED_KEYS = ['R2_PUBLIC_URL', 'GOOGLE_CLIENT_ID', 'SENTRY_DSN', 'TURNSTILE_SITE_KEY'];
const SERVER_DIR = path.join(__dirname, '../../server');
const PRODUCTION = process.argv.includes('--production');

function readWranglerVars() {
  const file = path.join(SERVER_DIR, 'wrangler.jsonc');
  if (!fs.existsSync(file)) return {};
  // JSON with whole-line // comments (URLs inside strings are left alone).
  const json = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(json).vars || {};
}

function readDevVars() {
  const file = path.join(SERVER_DIR, '.dev.vars');
  if (!fs.existsSync(file)) return {};
  const vars = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); // later lines win, as in wrangler
  }
  return vars;
}

const serverVars = { ...readWranglerVars(), ...(PRODUCTION ? {} : readDevVars()) };
for (const key of SHARED_KEYS) {
  if (!process.env[key] && serverVars[key]) process.env[key] = serverVars[key];
}

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
  sentryDsn: '${process.env.SENTRY_DSN || ''}',
  googleClientId: '${process.env.GOOGLE_CLIENT_ID || ''}',
  turnstileSiteKey: '${process.env.TURNSTILE_SITE_KEY || ''}'
};
`;

const prodConfigFile = `
export const environment = {
  production: true,
  backendUrl: '${backendUrl}',
  gaMeasurementId: '${process.env.NG_APP_GA_MEASUREMENT_ID || ''}',
  sentryDsn: '${process.env.SENTRY_DSN || ''}',
  googleClientId: '${process.env.GOOGLE_CLIENT_ID || ''}',
  turnstileSiteKey: '${process.env.TURNSTILE_SITE_KEY || ''}'
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
    const buildOptions = angularJson.projects['unibooks'].architect.build.options;
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
// R2_PUBLIC_URL comes from the server's configuration (see the top of this
// file), so the media host in the CSP is always the one the server issues
// image URLs for. Frontend-only settings keep the NG_APP_ prefix
// (NG_APP_BACKEND_URL, NG_APP_CSP_ENFORCE, NG_APP_GA_MEASUREMENT_ID).
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
// repositories (SchoolList's schools.<REGION>.json, CategoryList's
// categories.json). The path keeps it to CycleUni's own files rather than
// everything raw.githubusercontent.com serves.
const IMPORT_LIST_SOURCE = 'https://raw.githubusercontent.com/CycleUni/';

// Firebase Cloud Messaging: the SDK registers the browser with these two hosts
// to get a push token (the messages themselves arrive over the browser's push
// service, which is not a page connection).
const FIREBASE_REGISTRATION = ['https://fcmregistrations.googleapis.com', 'https://firebaseinstallations.googleapis.com'];

// Sentry error reports and replays are POSTed to the project's ingest host,
// named exactly (from the DSN): a wildcard would let injected code report to
// any Sentry project, an attacker's included.
const SENTRY_INGEST = originOf(process.env.SENTRY_DSN);

// Google Analytics 4: gtag.js (script-src googletagmanager.com) sends its hits
// to these hosts, by fetch/sendBeacon and as image pixels — Google's own CSP
// guidance for GA4. Without them an enforcing policy silently drops every hit.
const GA_CONNECT = ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com'];
const GA_IMG = ['https://*.google-analytics.com', 'https://*.googletagmanager.com'];

// connect-src 'self' covers the chat WebSocket (wss://<this host>/api/chat/…):
// CSP Level 3 matches ws:/wss: on the page's own host for 'self', which every
// supported browser implements.
function buildCsp({ backendOrigin, mediaOrigin }) {
  const connect = ["'self'", backendOrigin, 'https://accounts.google.com', IMPORT_LIST_SOURCE, ...FIREBASE_REGISTRATION, ...GA_CONNECT, SENTRY_INGEST];
  const img = ["'self'", 'data:', 'blob:', mediaOrigin || 'https:', 'https://lh3.googleusercontent.com', ...GA_IMG];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // gtag.js by path: the bare host would also serve gtm.js for any
    // container id, a known way around a CSP that allows it.
    "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com https://www.googletagmanager.com/gtag/ https://static.cloudflareinsights.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src ${[...new Set(img.filter(Boolean))].join(' ')}`,
    `connect-src ${[...new Set(connect.filter(Boolean))].join(' ')}`,
    // Turnstile renders its challenge in an iframe from challenges.cloudflare.com.
    'frame-src https://accounts.google.com https://challenges.cloudflare.com',
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

/** The console's own policy: the site-wide one with img-src open to https: (see public/_headers). */
function adminPolicy(policy) {
  return policy.replace(/img-src [^;]*/, "img-src 'self' data: blob: https:");
}

/**
 * Replace the CSP lines of a _headers file's text. The `/*` rule gets the
 * site-wide policy; the admin console rules (`/:region/admin`, `/:region/admin/*`) keep
 * their detach lines and get the same policy with an open img-src.
 */
function rewriteCsp(original, enforce, policy) {
  const headerName = enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
  const linesFor = (p) => {
    const line = `  ${headerName}: ${p}`;
    // Enforcing the full policy supersedes the always-enforced subset.
    return enforce ? [line] : [`  Content-Security-Policy: ${ALWAYS_ENFORCED}`, line];
  };
  const replacedIn = new Set();
  let rule = '';
  return original
    .split('\n')
    .flatMap(l => {
      if (/^\S/.test(l) && !l.startsWith('#')) rule = l.trim();
      if (!/^ {2}Content-Security-Policy(-Report-Only)?:/.test(l)) return [l];
      if (replacedIn.has(rule)) return [];
      replacedIn.add(rule);
      return linesFor(/\/admin(\/\*)?$/.test(rule) ? adminPolicy(policy) : policy);
    })
    .join('\n');
}

if (HEADERS_ONLY) {
  const headersPath = path.join(__dirname, '../dist/unibooks/browser/_headers');
  const mediaOrigin = originOf(process.env.R2_PUBLIC_URL);
  if (!fs.existsSync(headersPath)) {
    console.error(`[set-env] ${headersPath} not found — run after ng build`);
    process.exit(1);
  }
  if (!mediaOrigin) {
    console.log('CSP left as committed — R2_PUBLIC_URL is not set in server/wrangler.jsonc vars');
  } else {
    // Enforcing needs the media host: without it img-src keeps its https:
    // fallback, a policy only worth watching.
    const enforce = process.env.NG_APP_CSP_ENFORCE === '1';
    const original = fs.readFileSync(headersPath, 'utf8');
    const rewritten = rewriteCsp(original, enforce, buildCsp({
      backendOrigin: originOf(backendUrl),
      mediaOrigin,
    }));
    fs.writeFileSync(headersPath, rewritten, { encoding: 'utf8' });
    console.log(`CSP written to ${path.relative(process.cwd(), headersPath)} (${enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'})`);
  }
}

