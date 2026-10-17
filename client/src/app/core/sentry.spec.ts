import { sentry, startSentry } from './sentry';

// With no DSN (the test environment) Sentry stays off: nothing is queued and
// nothing loads, so every call is safe to make from any code path.
describe('sentry facade', () => {
  it('does nothing without a DSN', () => {
    expect(() => {
      sentry.captureException(new Error('boom'));
      sentry.setUser({ id: '1' });
      startSentry();
    }).not.toThrow();
  });
});
