import { describe, it, expect } from 'vitest';
import { parseAdminError } from './admin-error.util';
import { en } from './i18n/en';

// Stands in for I18nService. t() echoes the key back when there is no entry;
// tOrNull() is the guard built on that, and it is what parseAdminError leans on
// to tell a real code from a string that merely looks like one. Both are
// reproduced here rather than stubbed loosely, so the double cannot drift from
// the service and quietly make the guard untested.
const i18n = {
  t: (key: string) => en[key] ?? key,
  tOrNull: (key: unknown) => {
    if (typeof key !== 'string' || !key) return null;
    return en[key] ?? null;
  },
} as any;

describe('parseAdminError', () => {
  it('reads the {"error": {"code": ...}} shape the views use', () => {
    const err = { error: { error: { code: 'admin.errRegionForbidden' } } };
    expect(parseAdminError(err, i18n)).toBe(en['admin.errRegionForbidden']);
  });

  it('reads field errors', () => {
    const body = { error: { code: 'common.errValidation', fields: { default_language: ['admin.errDefaultLanguageNotSupported'] } } };
    expect(parseAdminError({ error: body }, i18n)).toBe(en['admin.errDefaultLanguageNotSupported']);
  });

  it('falls back rather than showing a raw key', () => {
    // i18n.t() echoes an unknown key, and echoing 'admin.errSomethingNew' at
    // an admin is worse than the generic sentence.
    expect(parseAdminError({ error: { error: { code: 'admin.errNotTranslatedYet' } } }, i18n))
      .toBe(en['admin.errGeneric']);
    expect(parseAdminError({}, i18n)).toBe(en['admin.errGeneric']);
  });

  it('honours a caller-supplied fallback', () => {
    expect(parseAdminError({}, i18n, 'admin.errSaveFailed')).toBe(en['admin.errSaveFailed']);
  });
});
