import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { parseJsonArray } from '../../lib/json';
import { getRegion } from '../../lib/region';
import { pickLanguage, requestedLanguage } from '../accounts/i18n';
import { pickTranslation } from '../accounts/regionData';

/**
 * Language resolution, normalization and translation picking. Model rows store canonical English in their plain fields
 * and localized values in a `translations` JSON column.
 */

/** ?lang= wins, then Accept-Language, then the region's default language. */
export async function resolveLanguage(c: Context<AppEnv>): Promise<string> {
  const region = await getRegion(c);
  return pickLanguage(requestedLanguage(c), region?.defaultLanguage ?? null, region ? parseJsonArray<string>(region.languages) : null);
}

/** A localized field with fallback to the canonical value. */
export function localized(translationsJson: string | null | undefined, lang: string | null, field: string, fallback: string): string {
  const v = pickTranslation(translationsJson, lang)[field];
  return typeof v === 'string' && v ? v : fallback;
}
