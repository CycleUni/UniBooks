import { chunkUrlFromError, isChunkLoadError } from './app';

// A tab running the build before a deploy asks for a lazy chunk the deploy
// removed; each browser words the failure differently.
describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://cycleunife.pages.dev/chunk-OLD.js',   // Chrome
    'error loading dynamically imported module: https://cycleunife.pages.dev/chunk-OLD.js',     // Firefox
    'Importing a module script failed.',                                                         // Safari
    "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\".",
    'Loading chunk chunk-ABC123 failed.',
  ])('recognizes "%s"', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it('leaves other navigation errors alone', () => {
    expect(isChunkLoadError(new Error('Cannot match any routes. URL Segment: "nope"'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('chunkUrlFromError', () => {
  it('finds the chunk a Chrome or Firefox message names', () => {
    expect(chunkUrlFromError(new Error('Failed to fetch dynamically imported module: https://unibooks.app/chunk-OLD_1a.js')))
      .toBe('https://unibooks.app/chunk-OLD_1a.js');
    expect(chunkUrlFromError(new Error('error loading dynamically imported module: https://unibooks.app/chunk-OLD.js')))
      .toBe('https://unibooks.app/chunk-OLD.js');
  });

  it('returns null when the message carries no URL', () => {
    expect(chunkUrlFromError(new Error('Importing a module script failed.'))).toBeNull();
    expect(chunkUrlFromError(undefined)).toBeNull();
  });
});
