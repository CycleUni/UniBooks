import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UiVerificationPrompt } from './verification-prompt.component';
import { provideRouter } from '@angular/router';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';


describe('UiVerificationPrompt', () => {
  let component: UiVerificationPrompt;
  let fixture: ComponentFixture<UiVerificationPrompt>;

  beforeEach(async () => {
    sessionStorage.clear();

    await TestBed.configureTestingModule({
      imports: [UiVerificationPrompt],
      providers: [
        { provide: RegionService, useValue: { regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }], currency: () => ({ code: 'TWD', decimal_places: 0 }), region: () => 'tw', currentRegionObj: () => ({ search_engines: ['googlebooks'] }) } },
        provideRouter([]),
        { provide: I18nService, useValue: { t: (k: string) => k, lang: () => 'zh-TW' } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(UiVerificationPrompt);
    component = fixture.componentInstance;
    component.storageKey = 'test.verification_prompt.dismissed';
    fixture.detectChanges();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('should render the prompt when not dismissed', () => {
    const banner = fixture.nativeElement.querySelector('.verification-prompt-banner');
    expect(banner).toBeTruthy();
  });

  it('should dismiss and persist to sessionStorage when dismiss button is clicked', () => {
    const dismissBtn = fixture.nativeElement.querySelector('.dismiss-btn');
    expect(dismissBtn).toBeTruthy();

    let emitted = false;
    component.onDismiss.subscribe(() => {
      emitted = true;
    });

    dismissBtn.click();
    fixture.detectChanges();

    expect(sessionStorage.getItem('test.verification_prompt.dismissed')).toBe('true');
    expect(emitted).toBe(true);
    expect(component.isDismissed).toBe(true);

    const banner = fixture.nativeElement.querySelector('.verification-prompt-banner');
    expect(banner).toBeNull();
  });
});
