import { describe, it, expect } from 'vitest';
import { parseApiError, translateApiError } from './api-error.util';
import { en } from './i18n/en';

// Same double as admin-error.util.spec: t() echoes an unknown key, tOrNull()
// is the guard built on that, and telling a real code from a string that
// merely looks like one is the whole job here.
const i18n = {
  t: (key: string) => en[key] ?? key,
  tOrNull: (key: unknown) => {
    if (typeof key !== 'string' || !key) return null;
    return en[key] ?? null;
  },
} as any;

describe('parseApiError', () => {
  it('reads the {"error": {"code": ...}} shape hand-written views use', () => {
    // Google sign-in with an address Google has not verified.
    const err = { error: { error: { code: 'auth.errEmailNotVerified' } } };
    expect(parseApiError(err, i18n, 'auth.errGoogleLoginFailed'))
      .toBe(en['auth.errEmailNotVerified']);
  });

  it('reads the DRF field shape a serializer raise produces', () => {
    // The accept-order guard raises ValidationError({'status': ...}), which
    // never passes through the {"error": {...}} contract.
    expect(parseApiError({ error: { status: ['checkout.errListingUnavailable'] } }, i18n, 'acct.updateFailed'))
      .toBe(en['checkout.errListingUnavailable']);
  });

  it('falls back rather than showing the user a raw key', () => {
    expect(parseApiError({ error: { error: { code: 'listing.errNotTranslatedYet' } } }, i18n, 'acct.updateFailed'))
      .toBe(en['acct.updateFailed']);
    expect(parseApiError({ error: { detail: 'Some untranslated prose' } }, i18n, 'acct.updateFailed'))
      .toBe(en['acct.updateFailed']);
    expect(parseApiError({}, i18n, 'acct.updateFailed')).toBe(en['acct.updateFailed']);
  });

  it('survives a body that is not an object', () => {
    expect(parseApiError({ error: 'Bad Gateway' }, i18n, 'acct.updateFailed')).toBe(en['acct.updateFailed']);
    expect(parseApiError({ error: ['nope'] }, i18n, 'acct.updateFailed')).toBe(en['acct.updateFailed']);
  });
});

describe('translateApiError', () => {
  it('reads a serializer raise on a nested field', () => {
    // The chat-report check that the reported party is really the other
    // participant answers {"reported_party": [...]}, which the report modal
    // was not reading at all.
    expect(translateApiError({ error: { reported_party: ['moderation.errInvalidReportedParty'] } }, i18n))
      .toBe(en['moderation.errInvalidReportedParty']);
  });

  it('answers null so the caller can keep its own fallback', () => {
    // The report modal still prefers DRF's `detail` prose (a throttle notice,
    // say) over its generic sentence, which a fallback key would swallow.
    expect(translateApiError({ error: { detail: 'Request was throttled.' } }, i18n)).toBeNull();
    expect(translateApiError({}, i18n)).toBeNull();
  });
});
