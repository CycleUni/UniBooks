import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { UiWelcomeDialog } from './welcome-dialog.component';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { MetadataService } from '../../core/services/metadata.service';
import { AccountService } from '../../core/services/account.service';
import { GoogleAuthService } from '../../core/services/google-auth.service';
import { ToastService } from '../../core/services/toast.service';
import { I18nService } from '../../core/i18n.service';

describe('UiWelcomeDialog', () => {
  let component: UiWelcomeDialog;
  let fixture: ComponentFixture<UiWelcomeDialog>;
  let mockAuth: any;
  let mockSchoolState: any;
  let mockMetadata: any;
  let userSignal: any;
  let isAuthedSignal: any;
  let router: Router;

  const mockSchools = [
    { id: 1, code: 'NTU', name: 'National Taiwan University', requires_verification: false, email_domains: ['ntu.edu.tw'] },
    { id: 2, code: 'MANDATORY', name: 'Mandatory School', requires_verification: true, email_domains: ['mand.edu.tw'], google_domains: ['mand.edu.tw'] },
  ];

  beforeEach(async () => {
    userSignal = signal<any>({ id: 'u1', email: 'test@example.com', school_prompted: false, school_prompted_at: null });
    isAuthedSignal = signal<boolean>(true);

    mockAuth = {
      isAuthenticated: isAuthedSignal,
      user: userSignal,
      setDeclaredSchool: vi.fn().mockReturnValue(of({})),
      fetchUserProfile: vi.fn(),
    };

    mockSchoolState = {
      setManualSchool: vi.fn(),
    };

    mockMetadata = {
      getMetadataWithRetry: vi.fn().mockReturnValue(of({ schools: mockSchools })),
    };

    await TestBed.configureTestingModule({
      imports: [UiWelcomeDialog],
      providers: [
        provideRouter([]),
        { provide: AuthStore, useValue: mockAuth },
        {
          provide: RegionService,
          useValue: {
            region: () => 'tw',
            regions: () => [{ code: 'tw' }],
            currentRegionObj: () => ({ code: 'tw', edu_email_suffix: ['.edu.tw'] }),
          },
        },
        { provide: SchoolStateService, useValue: mockSchoolState },
        { provide: MetadataService, useValue: mockMetadata },
        {
          provide: AccountService,
          useValue: {
            requestEduVerification: vi.fn().mockReturnValue(of({})),
            getGoogleVerifyOptions: vi.fn().mockReturnValue(of({ nonce: 'n-123' })),
            verifyWithGoogle: vi.fn().mockReturnValue(of({})),
          },
        },
        { provide: GoogleAuthService, useValue: { verifyCampusGoogle: vi.fn() } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        {
          provide: I18nService,
          useValue: {
            t: (k: string, p?: any) => (p?.school ? `${p.school}: ${k}` : k),
            lang: () => 'zh-TW',
          },
        },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate');
    fixture = TestBed.createComponent(UiWelcomeDialog);
    component = fixture.componentInstance;
  });

  it('opens for signed-in user who has not been prompted', () => {
    fixture.detectChanges();
    expect(component.isOpen).toBe(true);
    expect(component.step).toBe('school');
    expect(component.schools.length).toBe(2);
  });

  it('remains closed for signed-out visitors', () => {
    isAuthedSignal.set(false);
    userSignal.set(null);
    fixture = TestBed.createComponent(UiWelcomeDialog);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.isOpen).toBe(false);
  });

  it('remains closed if user has already been prompted', () => {
    userSignal.set({ id: 'u1', email: 'test@example.com', school_prompted: true, school_prompted_at: '2026-01-01T00:00:00Z' });
    fixture = TestBed.createComponent(UiWelcomeDialog);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.isOpen).toBe(false);
  });

  it('remains closed on excluded routes (login, register, verify, admin)', () => {
    vi.spyOn(router, 'url', 'get').mockReturnValue('/tw/login');
    fixture = TestBed.createComponent(UiWelcomeDialog);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.isOpen).toBe(false);
  });

  it('calling onSkip marks prompted via setDeclaredSchool with null and closes dialog', () => {
    fixture.detectChanges();
    expect(component.isOpen).toBe(true);

    component.onSkip();

    expect(mockAuth.setDeclaredSchool).toHaveBeenCalledWith('tw', null, true);
    expect(component.isOpen).toBe(false);
  });

  it('confirming a non-mandatory school sets declared and browsing school, then closes dialog', () => {
    fixture.detectChanges();
    component.selectSchool(mockSchools[0]);
    component.confirmSchoolChoice();

    expect(mockAuth.setDeclaredSchool).toHaveBeenCalledWith('tw', 'NTU');
    expect(mockSchoolState.setManualSchool).toHaveBeenCalledWith('NTU');
    expect(component.isOpen).toBe(false);
  });

  it('confirming a mandatory school transitions to verify step, where user can go to verification', () => {
    fixture.detectChanges();
    component.selectSchool(mockSchools[1]);
    component.confirmSchoolChoice();

    expect(mockAuth.setDeclaredSchool).toHaveBeenCalledWith('tw', 'MANDATORY');
    expect(mockSchoolState.setManualSchool).toHaveBeenCalledWith('MANDATORY');
    expect(component.isOpen).toBe(true);
    expect(component.step).toBe('verify');

    component.goToVerification();
    expect(component.isOpen).toBe(false);
    expect(router.navigate).toHaveBeenCalledWith(['/', 'tw', 'account', 'verification']);
  });

  it('allows continuing without verification from verify step', () => {
    fixture.detectChanges();
    component.selectSchool(mockSchools[1]);
    component.confirmSchoolChoice();
    expect(component.step).toBe('verify');

    component.finishAndClose();
    expect(component.isOpen).toBe(false);
  });
});
