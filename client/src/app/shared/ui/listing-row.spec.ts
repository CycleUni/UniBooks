import { RegionService } from '../../core/region.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UiListingRow } from './listing-row.component';
import { I18nService } from '../../core/i18n.service';
import { By } from '@angular/platform-browser';

describe('UiListingRow', () => {
  let component: UiListingRow;
  let fixture: ComponentFixture<UiListingRow>;
  let mockI18n: any;

  beforeEach(() => {
    mockI18n = {
      lang: () => 'zh-TW',
      t: (key: string, params?: Record<string, string | number>) => {
        let text = `Translated: ${key}`;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text += ` (${name}=${value})`;
          }
        }
        return text;
      }
    };

    TestBed.configureTestingModule({
      imports: [UiListingRow],
      providers: [
        { provide: I18nService, useValue: mockI18n },
        { provide: RegionService, useValue: { currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }), regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }] } }
      ]
    });
    fixture = TestBed.createComponent(UiListingRow);
    component = fixture.componentInstance;
  });

  it('should render translated conditionText correctly', () => {
    component.condition = 'new';
    component.ngOnChanges({
      condition: {
        currentValue: 'new',
        previousValue: undefined,
        firstChange: true,
        isFirstChange: () => true
      }
    });
    fixture.detectChanges();
    expect(component.conditionText).toBe('Translated: cond.new');
  });

  it('should apply fallback alt text if title is missing', () => {
    component.coverUrl = 'test.jpg';
    fixture.detectChanges();
    const img = fixture.debugElement.query(By.css('img')).nativeElement;
    expect(img.alt).toBe('Translated: home.unknownBook');
  });

  it('should apply title as alt text', () => {
    component.coverUrl = 'test.jpg';
    component.title = 'My Awesome Book';
    fixture.detectChanges();
    const img = fixture.debugElement.query(By.css('img')).nativeElement;
    expect(img.alt).toBe('My Awesome Book');
  });

  it('should hide price if null', () => {
    // default price is undefined, which should hide it
    fixture.detectChanges();
    const priceDiv = fixture.debugElement.query(By.css('.price'));
    expect(priceDiv).toBeNull();
    
    fixture.componentRef.setInput('price', 0);
    fixture.detectChanges();
    const zeroPriceDiv = fixture.debugElement.query(By.css('.price'));
    expect(zeroPriceDiv).toBeTruthy();
  });

  it('renders waitlist badge as-is below threshold and caps at 9999+ above threshold', () => {
    fixture.componentRef.setInput('waitlistCount', 5);
    fixture.detectChanges();
    let badge = fixture.debugElement.query(By.css('ui-badge[type="waitlist"]'));
    expect(badge.nativeElement.textContent).toContain('n=5');

    fixture.componentRef.setInput('waitlistCount', 10000);
    fixture.detectChanges();
    badge = fixture.debugElement.query(By.css('ui-badge[type="waitlist"]'));
    expect(badge.nativeElement.textContent).toContain('n=9999+');
  });
});
