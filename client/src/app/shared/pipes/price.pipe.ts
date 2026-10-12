import { Pipe, PipeTransform, inject } from '@angular/core';
import { RegionService } from '../../core/region.service';
import { I18nService } from '../../core/i18n.service';

/**
 * Formats a minor-unit price into localized currency string based on current region.
 *
 * Edge cases:
 * - null / undefined / '' -> ''
 * - 0 -> normal formatted output
 * - non-numeric string (e.g. '-') -> original value as string
 */
@Pipe({
  name: 'price',
  standalone: true,
  pure: false
})
export class PricePipe implements PipeTransform {
  private regionService = inject(RegionService);
  private i18n = inject(I18nService);

  transform(value: number | string | null | undefined, currencyCode?: string): string {
    if (value === null || value === undefined || value === '') {
      return '';
    }

    const num = typeof value === 'number' ? value : Number(value);
    if (isNaN(num)) {
      return String(value);
    }

    const currency = this.regionService.currency();
    const activeCurrencyCode = currencyCode || currency.code;
    
    let decimalPlaces = currency.decimal_places;
    if (activeCurrencyCode !== currency.code) {
      const regions = this.regionService.regions();
      const foundRegion = regions.find(r => r.currency.code === activeCurrencyCode);
      if (foundRegion) {
        decimalPlaces = foundRegion.currency.decimal_places;
      } else {
        try {
          const options = new Intl.NumberFormat(this.i18n.lang(), { style: 'currency', currency: activeCurrencyCode }).resolvedOptions();
          decimalPlaces = options.maximumFractionDigits ?? currency.decimal_places;
        } catch (e) {
          console.warn(`Unsupported currency code: ${activeCurrencyCode}`);
        }
      }
    }
    
    const lang = this.i18n.lang();
    let localeFromLang = lang; // Use the raw language code directly to support new languages automatically

    const major = num / Math.pow(10, decimalPlaces);
    
    try {
      const formatter = new Intl.NumberFormat(localeFromLang, {
        style: 'currency',
        currency: activeCurrencyCode,
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces
      });

      return formatter.format(major);
    } catch (e) {
      return `${activeCurrencyCode} ${major}`;
    }
  }
}
