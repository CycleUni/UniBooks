import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { VerificationComponent } from './verification';
import { RegionService } from '../../core/region.service';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { GoogleAuthService } from '../../core/services/google-auth.service';
import { SchoolStateService } from '../../core/services/school-state.service';
import { en } from '../../core/i18n/en';
import { signal } from '@angular/core';

describe('VerificationComponent', () => {
  let component: VerificationComponent;
  let googleAuthMock: any;
  let teardownFn: any;
  let schoolStateMock: any;

  beforeEach(() => {
    teardownFn = vi.fn();
    googleAuthMock = {
      buttonFailed: signal(false),
      renderCampusVerifyButton: vi.fn().mockImplementation((_el, options) => {
        options?.onReady?.();
        return teardownFn;
      }),
    };
    schoolStateMock = {
      currentSchool: null,
      getManualSchool: vi.fn().mockReturnValue(null),
      setManualSchool: vi.fn(),
      setRegion: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [VerificationComponent, HttpClientTestingModule, RouterTestingModule],
      providers: [
        RegionService,
        AuthStore,
        AccountService,
        { provide: GoogleAuthService, useValue: googleAuthMock },
        { provide: SchoolStateService, useValue: schoolStateMock },
      ],
    });

    const fixture = TestBed.createComponent(VerificationComponent);
    component = fixture.componentInstance;
  });

  describe('two-year expiry', () => {
    const tw = { code: 'TW', edu_email_suffix: ['edu.tw'] };
    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    beforeEach(() => {
      (component as any).regionService = { currentRegionObj: () => tw };
    });

    it('offers renewal only in the last 60 days', () => {
      component.verifications = [
        { region: 'TW', edu_email: 'a@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(200) },
      ];
      expect(component.renewalDue).toBe(false);
      component.verifications = [
        { region: 'TW', edu_email: 'a@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(10) },
      ];
      expect(component.renewalDue).toBe(true);
    });

    it("names the region's lapsed verification only while no live one replaces it", () => {
      component.lapsedVerifications = [
        { region: 'TW', edu_email: 'a@ntu.edu.tw', expires_at: '2022-01-01T00:00:00Z' },
      ];
      component.verifications = [];
      expect(component.currentLapsed?.edu_email).toBe('a@ntu.edu.tw');
      component.verifications = [
        { region: 'TW', edu_email: 'a@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(700) },
      ];
      expect(component.currentLapsed).toBeNull();
    });

    it('renews through the server without sending any address', () => {
      const renew = vi.fn().mockReturnValue(of({ code: 'acct.sentVerification', edu_email: 'b@ntu.edu.tw' }));
      (component as any).accountService = { renewVerification: renew };
      const mail = vi.spyOn(component as any, 'submitEduVerification');
      component.verifications = [
        { region: 'TW', edu_email: 'b@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(5) },
      ];
      component.onVerifyWithOldEmail();
      expect(renew).toHaveBeenCalledWith();
      expect(mail).not.toHaveBeenCalled();
      expect(component.clientVerifyMsg).toBe('acct.sentVerification');
      expect(component.resendCooldownSeconds).toBeGreaterThan(0);
    });

    it("offers a lapsed verification's old address, and a new one when changing", () => {
      const mail = vi.spyOn(component as any, 'submitEduVerification').mockImplementation(() => {});
      component.verifications = [];
      component.lapsedVerifications = [
        { region: 'TW', edu_email: 'old@ntu.edu.tw', expires_at: '2022-01-01T00:00:00Z' },
      ];
      component.email = 'me@gmail.com';
      expect(component.renewOldEmail).toBe('old@ntu.edu.tw');
      component.onChangeEduEmail();
      expect(component.changingEduEmail).toBe(true);
      expect(component.eduEmail).toBe('');
      component.eduEmail = 'new@ntu.edu.tw';
      component.onSubmitNewEduEmail();
      expect(mail).toHaveBeenLastCalledWith('new@ntu.edu.tw');
    });

    it('has no old address for a manual verification', () => {
      component.verifications = [
        { region: 'TW', edu_email: null, verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(5) },
      ];
      expect(component.renewOldEmail).toBeNull();
    });

    it('mentions Google sign-in only for a Google-linked account signing in with the bound campus address', () => {
      component.verifications = [
        { region: 'TW', edu_email: 'me@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(5) },
      ];
      component.email = 'me@ntu.edu.tw';
      component.isGoogleLinked = false;
      expect(component.googleRenews).toBe(false);
      component.isGoogleLinked = true;
      expect(component.googleRenews).toBe(true);
      component.email = 'other@ntu.edu.tw';
      expect(component.googleRenews).toBe(false);
    });
  });

  describe('autoVerifyRegion', () => {
    it('should return region if verified_at is null', () => {
      const mockRegion = { code: 'TW', edu_email_suffix: ['edu.tw'] };
      (component as any).regionService = { currentRegionObj: () => mockRegion };

      component.email = 'test@test.edu.tw';
      component.verifications = [
        { region: 'TW', school: 1, edu_email: 'test@edu.tw', verified_at: null },
      ];

      const result = component.autoVerifyRegion;
      expect(result).toBe(mockRegion as any);
    });

    it('should return null if region is verified', () => {
      const mockRegion = { code: 'TW', edu_email_suffix: ['edu.tw'] };
      (component as any).regionService = { currentRegionObj: () => mockRegion };

      component.email = 'test@test.edu.tw';
      component.verifications = [
        { region: 'TW', school: 1, edu_email: 'test@edu.tw', verified_at: '2026-08-28T12:27:44Z' },
      ];

      expect(component.autoVerifyRegion).toBeNull();
    });

    it('should handle region codes ignoring case', () => {
      const mockRegion = { code: 'TW', edu_email_suffix: ['edu.tw'] };
      (component as any).regionService = { currentRegionObj: () => mockRegion };

      component.email = 'test@test.edu.tw';
      component.verifications = [
        { region: 'tw', school: 1, edu_email: 'test@edu.tw', verified_at: '2026-08-28T12:27:44Z' },
      ];

      expect(component.autoVerifyRegion).toBeNull();
    });
  });

  describe('schoolNotSupported', () => {
    it('is true only for acct.errSchoolNotSupported', () => {
      expect(component.schoolNotSupported).toBe(false);

      component.lastVerifyError = { error: { error: { code: 'acct.errSchoolNotSupported' } } };
      expect(component.schoolNotSupported).toBe(true);

      component.lastVerifyError = { error: { error: { code: 'acct.errEduEmail' } } };
      expect(component.schoolNotSupported).toBe(false);
    });

    it('gives way to a newer client-side message', () => {
      component.lastVerifyError = { error: { error: { code: 'acct.errSchoolNotSupported' } } };
      component.clientVerifyMsg = 'acct.emailRequired';
      expect(component.schoolNotSupported).toBe(false);
    });
  });

  describe('campus email verification assisted form', () => {
    const mockSchools = [
      {
        id: 1,
        code: 'NTU',
        name: 'National Taiwan University',
        email_domain: 'ntu.edu.tw',
        student_email_domain: 'ntu.edu.tw',
        accepted_domains: ['ntu.edu.tw'],
      },
      {
        id: 2,
        code: 'CHIHLEE',
        name: 'Chihlee University of Technology',
        email_domain: 'chihlee.edu.tw',
        email_domains: ['gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
        student_email_domain: 'gm.chihlee.edu.tw',
        google_domains: ['gm.chihlee.edu.tw'],
        accepted_domains: ['chihlee.edu.tw', 'gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
      },
    ];

    beforeEach(() => {
      component.availableSchools = mockSchools;
      (component as any).metadataService = {
        getMetadata: () => of({ schools: mockSchools, cities: [] }),
      };
    });

    it('preselects site school and autofills student_email_domain', () => {
      (component as any).schoolStateService = {
        currentSchool: 'CHIHLEE',
        getManualSchool: () => 'CHIHLEE',
        setManualSchool: vi.fn(),
      };
      (component as any).accountService = {
        setDeclaredSchool: vi.fn().mockReturnValue(of({})),
        getStudentIdVerification: vi.fn().mockReturnValue(of({ request: null })),
      };
      component.loadSchoolsMetadata();

      expect(component.selectedSchoolCode).toBe('CHIHLEE');
      expect(component.selectedVerifyDomain).toBe('gm.chihlee.edu.tw');
      expect(component.schoolDomainChoices).toEqual(['gm.chihlee.edu.tw', 'mail.chihlee.edu.tw']);
    });

    it('identifies Google Workspace accounts per domain', () => {
      component.selectedSchoolCode = 'CHIHLEE';
      component.selectedSchoolOption = mockSchools[1];
      component['updateDomainChoices']();

      expect(component.selectedVerifyDomain).toBe('gm.chihlee.edu.tw');
      expect(component.isCurrentDomainGoogle).toBe(true);

      component.onDomainSelectChange('mail.chihlee.edu.tw');
      expect(component.selectedVerifyDomain).toBe('mail.chihlee.edu.tw');
      expect(component.isCurrentDomainGoogle).toBe(false);
    });

    it('splits pasted email address and selects matching school and domain', () => {
      component.loadSchoolsMetadata();
      component.selectedSchoolCode = 'NTU';
      component.selectedSchoolOption = mockSchools[0];

      component.handlePastedEmail('b10701001@mail.chihlee.edu.tw');
      expect(component.selectedSchoolCode).toBe('CHIHLEE');
      expect(component.eduLocalPart).toBe('b10701001');
      expect(component.selectedVerifyDomain).toBe('mail.chihlee.edu.tw');
      expect(component.useManualEmail).toBe(false);
    });

    it('submits composed address in assisted mode', () => {
      component.selectedSchoolCode = 'CHIHLEE';
      component.selectedSchoolOption = mockSchools[1];
      component['updateDomainChoices']();
      component.eduLocalPart = 'user123';
      const email = component.buildSubmitEmail();
      expect(email).toBe('user123@gm.chihlee.edu.tw');
    });

    it('supports other-address fallback escape hatch', () => {
      component.selectedSchoolCode = 'NTU';
      component.selectedSchoolOption = mockSchools[0];
      component['updateDomainChoices']();
      expect(component.schoolNeedsFullAddress).toBe(true);
      expect(component.selectedVerifyDomain).toBe('');
      component.eduEmail = 'b08901001@ntu.edu.tw';
      expect(component.buildSubmitEmail()).toBe('b08901001@ntu.edu.tw');

      component.eduEmail = 'b08901001@csie.ntu.edu.tw';
      expect(component.buildSubmitEmail()).toBe('b08901001@csie.ntu.edu.tw');
    });

    it('validates required fields when school or local part is missing', () => {
      component.selectedSchoolCode = '';
      component.eduLocalPart = '';
      component.useManualEmail = false;

      const emailNoSchool = component.buildSubmitEmail();
      expect(emailNoSchool).toBeNull();
      expect(component.clientVerifyMsg).toBe('acct.errSchoolRequired');

      component.selectedSchoolCode = 'NTU';
      component.selectedSchoolOption = mockSchools[0];
      component.eduLocalPart = '';
      const emailNoLocal = component.buildSubmitEmail();
      expect(emailNoLocal).toBeNull();
      expect(component.clientVerifyMsg).toBe('acct.emailRequired');
    });
  });

  describe('single school selector', () => {
    it('locks school display and shows verified school name when user has live verification', () => {
      (component as any).regionService = {
        currentRegionObj: () => ({ code: 'TW', localized_name: 'Taiwan' }),
        region: () => 'tw',
      };
      component.verifications = [
        {
          region: 'TW',
          school: 1,
          school_name: 'National Taiwan University',
          edu_email: 'test@ntu.edu.tw',
          verified_at: '2026-01-01T00:00:00Z',
        },
      ];
      component.availableSchools = [{ id: 1, code: 'NTU', name: 'National Taiwan University' }] as any;
      expect(component.isVerified).toBe(true);
      expect(component.currentVerifiedSchoolName).toBe('National Taiwan University');
    });

    it('calls setDeclaredSchool, updates schoolStateService, and recalibrates on school change', () => {
      const setDeclaredSchool = vi.fn().mockReturnValue(of({}));
      const setManualSchool = vi.fn();
      (component as any).accountService = { setDeclaredSchool };
      (component as any).schoolStateService = { setManualSchool };
      (component as any).regionService = { region: () => 'tw' };
      (component as any).authStore = { fetchUserProfile: vi.fn(), mustVerifyIn: () => false };

      component.availableSchools = [
        { id: 1, code: 'NTU', name: 'National Taiwan University', google_domains: [] },
      ] as any;

      component.onSchoolChange('NTU');

      expect(setDeclaredSchool).toHaveBeenCalledWith('tw', 'NTU');
      expect(setManualSchool).toHaveBeenCalledWith('NTU');
      expect(component.selectedSchoolCode).toBe('NTU');
      expect(component.selectedSchoolOption?.code).toBe('NTU');
    });

    it('allows dismissing soft verification invitation when mustVerify is false', () => {
      component.softInviteDismissed = false;
      component.dismissSoftInvite();
      expect(component.softInviteDismissed).toBe(true);
    });
  });

  describe('Google verify button lifecycle', () => {
    const chihleeSchool = {
      id: 2,
      code: 'CHIHLEE',
      name: 'Chihlee University of Technology',
      google_domains: ['gm.chihlee.edu.tw'],
    };

    beforeEach(() => {
      component.selectedSchoolOption = chihleeSchool as any;
      component.selectedSchoolCode = 'CHIHLEE';
      component.googleBtnRef = { nativeElement: document.createElement('div') };
      (component as any).accountService = {
        getGoogleVerifyOptions: vi.fn().mockReturnValue(of({ nonce: 'test-nonce-123' })),
        verifyWithGoogle: vi.fn().mockReturnValue(of({ code: 'acct.verifySuccess' })),
        clearProfileCache: vi.fn(),
      };
      (component as any).regionService = { region: () => 'tw' };
    });

    it('renders with nonce and single google_domain hd restriction', async () => {
      await component.setupGoogleButton();

      expect((component as any).accountService.getGoogleVerifyOptions).toHaveBeenCalled();
      expect(googleAuthMock.renderCampusVerifyButton).toHaveBeenCalledWith(
        component.googleBtnRef?.nativeElement,
        expect.objectContaining({
          nonce: 'test-nonce-123',
          hd: 'gm.chihlee.edu.tw',
        }),
      );
      expect(component.googleReady).toBe(true);
      expect(component.googleBlocked).toBe(false);
    });

    it('omits hd restriction if school has multiple google domains', async () => {
      component.selectedSchoolOption = {
        ...chihleeSchool,
        google_domains: ['gm.chihlee.edu.tw', 'other.chihlee.edu.tw'],
      } as any;

      await component.setupGoogleButton();

      expect(googleAuthMock.renderCampusVerifyButton).toHaveBeenCalledWith(
        component.googleBtnRef?.nativeElement,
        expect.objectContaining({
          nonce: 'test-nonce-123',
          hd: undefined,
        }),
      );
    });

    it('shows fallback when googleAuth.buttonFailed() is true', async () => {
      googleAuthMock.buttonFailed.set(true);

      await component.setupGoogleButton();

      expect(component.googleBlocked).toBe(true);
      expect(googleAuthMock.renderCampusVerifyButton).not.toHaveBeenCalled();
    });

    it('re-renders button and surfaces acct.errNotCampusGoogle on wrong account', async () => {
      const setupSpy = vi.spyOn(component, 'setupGoogleButton');
      (component as any).accountService.verifyWithGoogle = vi.fn().mockReturnValue(
        throwError(() => ({
          error: { error: { code: 'acct.errNotCampusGoogle' } },
        })),
      );

      await component.handleGoogleCredential('credential-xyz');

      expect(component.isVerifyingGoogle).toBe(false);
      expect(component.googleError).toBe(en['acct.errNotCampusGoogle']);
      expect(setupSpy).toHaveBeenCalled();
    });

    it('surfaces acct.errGoogleTokenExpired on expired or invalid token and re-renders', async () => {
      const setupSpy = vi.spyOn(component, 'setupGoogleButton');
      (component as any).accountService.verifyWithGoogle = vi.fn().mockReturnValue(
        throwError(() => ({
          error: { error: { code: 'auth.errInvalidToken' } },
        })),
      );

      await component.handleGoogleCredential('expired-cred');

      expect(component.googleError).toBe(en['acct.errGoogleTokenExpired']);
      expect(setupSpy).toHaveBeenCalled();
    });

    it('cleans up teardown and timers on ngOnDestroy', async () => {
      await component.setupGoogleButton();
      expect(teardownFn).not.toHaveBeenCalled();

      component.ngOnDestroy();
      expect(teardownFn).toHaveBeenCalled();
    });
  });

  describe('student ID card verification form states', () => {
    beforeEach(() => {
      (component as any).regionService = {
        region: () => 'tw',
        currentRegionObj: () => ({ code: 'TW', localized_name: 'Taiwan' }),
      };
      component.availableSchools = [
        { id: 10, code: 'CLUT', name: 'Chihlee University of Technology', allows_student_id_verification: true } as any,
        { id: 1, code: 'NTU', name: 'National Taiwan University', allows_student_id_verification: false } as any,
      ];
    });

    it('shows verification option only when school allows student ID verification', () => {
      component.selectedSchoolCode = 'NTU';
      expect(component.allowsStudentIdVerification).toBe(false);

      component.selectedSchoolCode = 'CLUT';
      expect(component.allowsStudentIdVerification).toBe(true);
    });

    it('submits student ID verification when not started', async () => {
      component.selectedSchoolCode = 'CLUT';
      component.studentNumberInput = 'c10901234';
      const file = new File(['dummy'], 'card.jpg', { type: 'image/jpeg' });
      component.selectedStudentIdFile = file;

      const uploadSpy = vi.fn().mockReturnValue(of({ url: 'tmp/student-ids/u1/card.jpg' }));
      const submitSpy = vi.fn().mockReturnValue(
        of({ id: 'req-1', status: 'pending', school: 'CLUT', student_number: 'C10901234' }),
      );
      const getVerifSpy = vi.fn().mockReturnValue(of({ request: { id: 'req-1', status: 'pending' } }));

      (component as any).accountService = {
        uploadStudentIdPhoto: uploadSpy,
        submitStudentIdVerification: submitSpy,
        getStudentIdVerification: getVerifSpy,
      };

      await component.onSubmitStudentIdVerification();

      expect(uploadSpy).toHaveBeenCalledWith(file, 'CLUT');
      expect(submitSpy).toHaveBeenCalledWith({
        school: 'CLUT',
        student_number: 'C10901234',
        image: 'tmp/student-ids/u1/card.jpg',
      });
      expect(component.studentNumberInput).toBe('');
      expect(component.selectedStudentIdFile).toBeNull();
    });

    it('displays pending request and allows user to cancel it', async () => {
      component.studentIdRequest = {
        id: 'req-1',
        status: 'pending',
        school: 'CLUT',
        school_name: 'Chihlee',
        student_number: 'C10901234',
        reject_reason: '',
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
        reviewed_at: null,
      };

      const cancelSpy = vi.fn().mockReturnValue(of({ ok: true, status: 'cancelled' }));
      const getVerifSpy = vi.fn().mockReturnValue(of({ request: null }));
      (component as any).accountService = {
        cancelStudentIdVerification: cancelSpy,
        getStudentIdVerification: getVerifSpy,
      };
      (component as any).confirms = {
        askDanger: vi.fn().mockResolvedValue(true),
      };

      await component.onCancelStudentIdVerification();

      expect((component as any).confirms.askDanger).toHaveBeenCalled();
      expect(cancelSpy).toHaveBeenCalled();
      expect(component.studentIdRequest).toBeNull();
    });

    it('displays rejected state with reason and enters resubmit mode', () => {
      component.studentIdRequest = {
        id: 'req-1',
        status: 'rejected',
        school: 'CLUT',
        school_name: 'Chihlee',
        student_number: 'C10901234',
        reject_reason: 'Photo is blurry',
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
        reviewed_at: '2026-11-02T00:00:00Z',
      };
      component.isResubmittingStudentId = false;

      component.startResubmitStudentId();

      expect(component.isResubmittingStudentId).toBe(true);
      expect(component.studentNumberInput).toBe('C10901234');
    });

    it('displays approved state with student number on currentVerification', () => {
      component.verifications = [
        {
          region: 'TW',
          school: 10,
          school_name: 'Chihlee University of Technology',
          edu_email: '',
          student_number: 'C10901234',
          verified_at: '2026-11-01T00:00:00Z',
        },
      ];

      expect(component.currentVerification).toBeTruthy();
      expect(component.currentVerification?.student_number).toBe('C10901234');
    });
  });
});
