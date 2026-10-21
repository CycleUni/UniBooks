import { scrubBreadcrumb } from './sentry-sdk';

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
