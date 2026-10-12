import { PricePipe } from './price.pipe';
import { TestBed } from '@angular/core/testing';
import { RegionService } from '../../core/region.service';
import { I18nService } from '../../core/i18n.service';

describe('PricePipe', () => {
  let pipe: PricePipe;
  let mockRegionService: any;
  let mockI18nService: any;

  beforeEach(() => {
    mockRegionService = {
      currency: vi.fn().mockReturnValue({ code: 'TWD', symbol: 'NT$', decimal_places: 0, symbol_position: 'prefix' })
    };
    mockI18nService = {
      lang: vi.fn().mockReturnValue('zh-TW')
    };

    TestBed.configureTestingModule({
      providers: [
        PricePipe,
        { provide: RegionService, useValue: mockRegionService },
        { provide: I18nService, useValue: mockI18nService }
      ]
    });
    pipe = TestBed.inject(PricePipe);
  });

  it('renders integer price for TWD (minor unit to major unit)', () => {
    // 100 minor = 100 major in TWD
    const formatted = pipe.transform(100);
    // Intl.NumberFormat might return '$100.00' or '$100', in zh-TW usually $100 for TWD
    expect(formatted).toContain('100');
    expect(formatted).toContain('$');
  });

  it('renders HKD minor units correctly', () => {
    mockRegionService.currency.mockReturnValue({ code: 'HKD', symbol: 'HK$', decimal_places: 2, symbol_position: 'prefix' });
    mockI18nService.lang.mockReturnValue('zh-HK');
    
    // 10050 minor = 100.50 major in HKD
    const formatted = pipe.transform(10050);
    expect(formatted).toContain('100.50');
    expect(formatted).toContain('HK$');
  });

  it('handles null, undefined, and empty string safely by returning empty string', () => {
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform('')).toBe('');
  });

  it('handles numeric string inputs correctly', () => {
    const formatted = pipe.transform('500');
    expect(formatted).toContain('500');
  });

  it('handles non-numeric string inputs by returning them unchanged', () => {
    expect(pipe.transform('-')).toBe('-');
    expect(pipe.transform('N/A')).toBe('N/A');
    expect(pipe.transform('Free')).toBe('Free');
  });
});
