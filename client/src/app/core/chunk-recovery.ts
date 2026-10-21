/**
 * Recovering from code that no longer exists. A tab still running the build
 * before a deploy asks for one of that build's lazy chunks, which the deploy
 * removed; the SPA fallback answers it with index.html and the import fails.
 * Loading the page again runs the current build, which never asks for the
 * old chunk. Shared by the router (app.ts) and every other dynamic import
 * (`importOrReload`).
 */

/**
 * Whether an error is a lazy chunk that could not be loaded: a missing
 * chunk, or index.html served in its place. Chrome, Firefox and Safari each
 * word it differently.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Expected a JavaScript(-or-Wasm)? module script|Loading chunk [\w-]+ failed/i.test(message);
}

/**
 * The chunk a failed dynamic import named, where the browser says (Chrome and
 * Firefox put the URL in the message; Safari does not).
 */
export function chunkUrlFromError(error: unknown): string | null {
  const message = String((error as { message?: unknown })?.message ?? error ?? '');
  return message.match(/https?:\/\/\S+?\.js\b/)?.[0] ?? null;
}

const RELOAD_KEY = 'unibooks.chunkReload';

/**
 * Load `url` (default: this page) as a full page, once per URL within ten
 * seconds, so a chunk that is genuinely broken cannot reload in a loop.
 * The failed chunk is refetched with cache: 'reload' first: a browser may
 * hold index.html under that chunk's URL with the year-long immutable cache
 * public/_headers sets for hashed bundles, and a plain reload would read
 * that copy again. Returns false when it did not reload.
 */
export function reloadForMissingChunk(error: unknown, url: string = location.href): boolean {
  // Offline, the import failed for want of a network, not because a deploy
  // removed the chunk: a reload would only swap the app for the browser's
  // offline page.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const last = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || 'null');
    if (last && last.url === url && Date.now() - last.at < 10_000) return false;
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ url, at: Date.now() }));
  } catch {
    // No sessionStorage, so nothing would remember this reload and a broken
    // chunk would reload the page forever: leave the error to the caller.
    return false;
  }
  const chunkUrl = chunkUrlFromError(error);
  const refreshed = chunkUrl ? fetch(chunkUrl, { cache: 'reload' }).then(() => undefined, () => undefined) : Promise.resolve();
  refreshed.then(() => location.assign(url));
  return true;
}

/**
 * A dynamic import outside routing (a library loaded on first use) that
 * reloads the page when its chunk is gone instead of failing for good in an
 * old tab. Other errors are rethrown unchanged for the caller to handle.
 */
export async function importOrReload<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (typeof location !== 'undefined' && isChunkLoadError(e)) reloadForMissingChunk(e);
    throw e;
  }
}
