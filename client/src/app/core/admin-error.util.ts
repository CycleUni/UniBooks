import { I18nService } from './i18n.service';
import { parseApiError } from './api-error.util';

/** The admin console's default fallback over the shared parser; the two
 *  response shapes it has to understand are not admin-specific, so the
 *  parsing itself lives in api-error.util alongside the other callers. */
export function parseAdminError(err: any, i18n: I18nService, fallbackKey = 'admin.errGeneric'): string {
  return parseApiError(err, i18n, fallbackKey);
}
