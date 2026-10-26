import { isRecoveredChunkError, scrubBreadcrumb } from './sentry-sdk';
import { reloadForMissingChunk } from './chunk-recovery';

describe('scrubBreadcrumb', () => {
  it('drops console log, info and debug lines, which may quote what someone typed', () => {
    for (const level of ['log', 'info', 'debug']) {
      expect(
        scrubBreadcrumb({ category: 'console', level, data: { arguments: ['a chat message'] } }),
      ).toBeNull();
    }
  });

  it('keeps console warnings and errors', () => {
    expect(scrubBreadcrumb({ category: 'console', level: 'error' })).not.toBeNull();
    expect(scrubBreadcrumb({ category: 'console', level: 'warning' })).not.toBeNull();
  });

  it('redacts tokens in navigation and request URLs', () => {
    const crumb = scrubBreadcrumb({
      category: 'navigation',
      data: { from: '/tw/forgot-password?token=secret', to: '/tw' },
    })!;
    expect(crumb.data!['from']).toBe('/tw/forgot-password?token=redacted');
  });
});

describe('isRecoveredChunkError', () => {
  const gone = new Error('Failed to fetch dynamically imported module: https://unibooks.app/chunk-OLD.js');

  // Another spec may already have started a reload in this module, so only
  // the state after one is checked.
  it('drops a missing chunk once a reload is under way, but nothing else', () => {
    sessionStorage.clear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
    expect(reloadForMissingChunk(gone)).toBe(true);
    expect(isRecoveredChunkError(gone)).toBe(true);
    expect(isRecoveredChunkError(new Error('boom'))).toBe(false);
    vi.restoreAllMocks();
  });
});
