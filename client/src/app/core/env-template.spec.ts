import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// .env.template is the only description of what this app needs configured.
// Nothing fails at build time when a variable is missing from it — the build
// simply proceeds with a default — so the first sign of an omission is a
// deployment behaving differently from the one it was copied from.
const ROOT = process.cwd();
const TEMPLATE = fs.readFileSync(path.join(ROOT, '.env.template'), 'utf-8');
const SET_ENV = fs.readFileSync(path.join(ROOT, 'scripts/set-env.js'), 'utf-8');

const declared = new Set(
  [...TEMPLATE.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1]),
);
const read = [...new Set(
  [...SET_ENV.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]),
)].sort();

describe('.env.template', () => {
  it('documents every variable the build actually reads', () => {
    const missing = read.filter(name => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it('reads at least the variables we know about, so the scan is working', () => {
    // Guards the regex above: if it silently matched nothing, the test before
    // this one would pass no matter what the template omitted.
    expect(read).toContain('NG_APP_BACKEND_URL');
    expect(read.length).toBeGreaterThanOrEqual(6);
  });

  it('lists key names without values, as its own header says', () => {
    // A value here is one a deployment inherits by copying the file without
    // noticing — the same trap UniBooks-BE's template had.
    const withValues = [...TEMPLATE.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm)]
      .map(m => m[1]);
    expect(withValues).toEqual([]);
  });

  it('declares each key once', () => {
    const names = [...TEMPLATE.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1]);
    const duplicates = [...new Set(names.filter(n => names.filter(x => x === n).length > 1))];
    expect(duplicates.sort()).toEqual([]);
  });

  it('spells shared variables the way the server Worker spells them', () => {
    // The point of dropping the NG_APP_ prefix on these: a whole KEY=VALUE
    // line can be copied between this and server/wrangler.jsonc "vars".
    // FRONTEND_URL keeps its old name but is the frontend's own now (the
    // site origin for the CSP's wss: entry).
    expect(declared.has('FRONTEND_URL')).toBe(true);
    expect(declared.has('R2_PUBLIC_URL')).toBe(true);
    expect(declared.has('NG_APP_MEDIA_URL')).toBe(false);
  });

  it('no longer asks for a separate chat origin', () => {
    // Chat is this origin's /api/chat (the same Worker serves app, API and chat).
    expect(declared.has('EDGE_CHAT_URL')).toBe(false);
    expect(declared.has('NG_APP_EDGE_CHAT_URL')).toBe(false);
  });
});
