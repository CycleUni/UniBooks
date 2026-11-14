import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { UiVerificationPrompt } from './verification-prompt.component';
import { provideRouter, Router } from '@angular/router';
import { I18nService } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

describe('UiVerificationPrompt', () => {
  let component: UiVerificationPrompt;
  let fixture: ComponentFixture<UiVerificationPrompt>;
  let mockAuth: any;
  let userSignal: any;
  let router: Router;

  beforeEach(async () => {
    const storage = typeof window !== 'undefined' ? window.sessionStorage : (globalThis as any).sessionStorage;
    if (storage) storage.clear();
    userSignal = signal({ email: 'test@example.com' });
    mockAuth = {
      user: userSignal,
      mustVerifyIn: () => true,
      isVerifiedIn: () => false,
      schoolForRegion: () => 'National Taiwan Univ',
    };

    await TestBed.configureTestingModule({
      imports: [UiVerificationPrompt],
      providers: [
        {
          provide: RegionService,
          useValue: {
            regions: () => [{ code: 'tw', currency: { code: 'TWD', decimal_places: 0 } }],
            currency: () => ({ code: 'TWD', decimal_places: 0 }),
            region: () => 'tw',
            currentRegionObj: () => ({ search_engines: ['googlebooks'], edu_email_suffix: ['.edu.tw'] }),
          },
        },
        provideRouter([]),
        { provide: I18nService, useValue: { t: (k: string, p?: any) => (p?.school ? `${p.school} 要求先驗證` : k), lang: () => 'zh-TW' } },
        { provide: AuthStore, useValue: mockAuth },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate');
    fixture = TestBed.createComponent(UiVerificationPrompt);
    component = fixture.componentInstance;
    component.storageKey = 'test.verification_prompt.dismissed';
    fixture.detectChanges();
  });

  const acceptButton = () =>
    fixture.nativeElement.querySelectorAll('[data-testid="verification-prompt"] button')[0] as HTMLButtonElement;

  const dismissButton = () =>
    fixture.nativeElement.querySelectorAll('[data-testid="verification-prompt"] button')[1] as HTMLButtonElement;

  afterEach(() => {
    const storage = typeof window !== 'undefined' ? window.sessionStorage : (globalThis as any).sessionStorage;
    if (storage) storage.clear();
  });

  it('should render the prompt when not dismissed', () => {
    const banner = fixture.nativeElement.querySelector('[data-testid="verification-prompt"]');
    expect(banner).toBeTruthy();
  });

  it('should dismiss and persist to sessionStorage when dismiss button is clicked', () => {
    const dismissBtn = dismissButton();
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

    const banner = fixture.nativeElement.querySelector('[data-testid="verification-prompt"]');
    expect(banner).toBeNull();
  });

  it('shows again when an action asks for it, even after a dismissal', () => {
    dismissButton().click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="verification-prompt"]')).toBeNull();

    fixture.componentRef.setInput('requested', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="verification-prompt"]')).toBeTruthy();
  });

  it('whenUnverified only shows when mustVerifyIn is true', async () => {
    fixture.componentRef.setInput('whenUnverified', true);
    mockAuth.mustVerifyIn = () => false;
    userSignal.set({ email: 'test@example.com', v: 1 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="verification-prompt"]')).toBeNull();

    mockAuth.mustVerifyIn = () => true;
    userSignal.set({ email: 'test@example.com', v: 2 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="verification-prompt"]')).toBeTruthy();
  });

  it('navigates to account/verification with returnUrl when accept button is clicked', () => {
    const btn = acceptButton();
    expect(btn).toBeTruthy();
    btn.click();
    expect(router.navigate).toHaveBeenCalledWith(
      ['/', 'tw', 'account', 'verification'],
      expect.objectContaining({ queryParams: expect.anything() }),
    );
  });
});
