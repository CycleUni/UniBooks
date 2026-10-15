import { I18nService } from './i18n.service';
import { parseApiError } from './api-error.util';

/** The admin console's default fallback over the shared parser in
 *  api-error.util. */
export function parseAdminError(err: any, i18n: I18nService, fallbackKey = 'admin.errGeneric'): string {
  return parseApiError(err, i18n, fallbackKey);
}
