import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { SettingsComponent } from './settings';
import { RegionService } from '../../core/region.service';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';

describe('SettingsComponent', () => {
  let component: SettingsComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SettingsComponent, HttpClientTestingModule, RouterTestingModule],
      providers: [
        RegionService,
        AuthStore,
        AccountService
      ]
    });
    
    const fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
  });

  describe('autoVerifyRegion', () => {
    it('should return region if verified_at is null', () => {
      // Mock regions and verifications
      const mockRegion = { code: 'TW', edu_email_suffix: ['edu.tw'] };
      (component as any).regionService = {
        currentRegionObj: () => mockRegion
      };
      
      component.email = 'test@test.edu.tw';
      component.verifications = [
        { region: 'TW', school: 1, edu_email: 'test@edu.tw', verified_at: null }
      ];

      const result = component.autoVerifyRegion;
      expect(result).toBe(mockRegion as any);
    });

    it('should return null if region is verified', () => {
      const mockRegion = { code: 'TW', edu_email_suffix: ['edu.tw'] };
      (component as any).regionService = {
        currentRegionObj: () => mockRegion
      };
      
      component.email = 'test@test.edu.tw';
      component.verifications = [
        { region: 'TW', school: 1, edu_email: 'test@edu.tw', verified_at: '2026-08-28T12:27:44Z' }
      ];

      const result = component.autoVerifyRegion;
      expect(result).toBeNull();
    });
    
    it('should handle region codes ignoring case', () => {
      const mockRegion = { code: 'TW', edu_email_suffix: ['edu.tw'] };
      (component as any).regionService = {
        currentRegionObj: () => mockRegion
      };
      
      component.email = 'test@test.edu.tw';
      component.verifications = [
        { region: 'tw', school: 1, edu_email: 'test@edu.tw', verified_at: '2026-08-28T12:27:44Z' }
      ];

      const result = component.autoVerifyRegion;
      expect(result).toBeNull();
    });
  });

  describe('schoolNotSupported', () => {
    // Gates the "report my school" form: only an address that resolved to no
    // School should offer it, not every verification failure.
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

  describe('pwdMessage', () => {
    it('spells out why the validators rejected the new password', () => {
      // Change-password runs AUTH_PASSWORD_VALIDATORS now, and answers in the
      // shape registration uses. Before this was read, "too short", "too
      // common" and "entirely numeric" all arrived as a bare "update failed".
      component.pwdIsError = true;
      (component as any).lastPwdError = {
        error: { error: { code: 'auth.errValidation', fields: ['This password is too common.'] } },
      };

      expect(component.pwdMessage).toContain('This password is too common.');
      expect(component.pwdMessage).not.toBe('Update failed. Please try again.');
    });

    it('does not show the registration wording for auth.errValidation itself', () => {
      // auth.errValidation reads "please provide an email and password",
      // which is nonsense on the change-password form.
      (component as any).lastPwdError = {
        error: { error: { code: 'auth.errValidation', fields: [] } },
      };

      expect(component.pwdMessage).toBe('Update failed. Please try again.');
    });

    it('still reports a wrong current password', () => {
      (component as any).lastPwdError = { error: { old_password: ['Incorrect password.'] } };

      expect(component.pwdMessage).toBe('Incorrect password.');
    });
  });

  describe('changing the sign-in email', () => {
    it('reports it as pending rather than saved', () => {
      // The address is not applied until the link sent to it is followed, so
      // "profile saved" would read as though it already had been.
      (component as any).accountService = {
        updateProfile: () => of({ code: 'acct.emailChangePending', pending_email: 'new@example.com' }),
        clearProfileCache: vi.fn(),
        getMyProfile: () => of({ id: 1, email: 'old@example.com', pending_email: 'new@example.com' }),
      };

      component.onUpdateProfile();

      expect(component.pendingEmail).toBe('new@example.com');
      expect((component as any).clientSettingsMsg).toBe('acct.emailChangePending');
    });

    it('still reports an ordinary save as saved', () => {
      (component as any).accountService = {
        updateProfile: () => of({ id: 1, email: 'same@example.com', first_name: 'A' }),
        clearProfileCache: vi.fn(),
        getMyProfile: () => of({ id: 1, email: 'same@example.com' }),
      };

      component.onUpdateProfile();

      expect(component.pendingEmail).toBeNull();
      expect((component as any).clientSettingsMsg).toBe('acct.profileSaved');
    });

    it('drops the pending address when the change is cancelled', () => {
      component.pendingEmail = 'new@example.com';
      (component as any).accountService = { cancelEmailChange: () => of({}) };
      (component as any).toast = { success: vi.fn(), error: vi.fn() };

      component.onCancelEmailChange();

      expect(component.pendingEmail).toBeNull();
    });
  });

  describe('hiding the Google avatar', () => {
    function switchInput(checked: boolean) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      return input;
    }

    it('saves the new setting', () => {
      const updateProfile = vi.fn(() => of({ id: 1, show_avatar: false }));
      (component as any).accountService = { updateProfile };
      (component as any).toast = { success: vi.fn(), error: vi.fn() };
      component.showAvatar = true;

      component.setShowAvatar(switchInput(false));

      expect(updateProfile).toHaveBeenCalledWith({ show_avatar: false });
      expect(component.showAvatar).toBe(false);
      expect(component.savingShowAvatar).toBe(false);
    });

    it('moves the switch back when the save fails', () => {
      (component as any).accountService = { updateProfile: () => throwError(() => ({ status: 500 })) };
      (component as any).toast = { success: vi.fn(), error: vi.fn() };
      component.showAvatar = true;
      const input = switchInput(false);

      component.setShowAvatar(input);

      expect(component.showAvatar).toBe(true);
      expect(input.checked).toBe(true);
      expect(component.savingShowAvatar).toBe(false);
    });
  });

  // Until /auth/me/ answers, empty inputs and an "unverified" banner would
  // read as facts about the account; the form waits behind a placeholder.
  describe('first profile load', () => {
    it('holds the form back until the profile arrives', () => {
      (component as any).restorePendingVerificationState = () => {};
      (component as any).accountService = { getMyProfile: () => of({ id: 1, email: 'a@example.com' }) };
      expect(component.profileLoaded).toBe(false);
      component.loadProfile();
      expect(component.profileLoaded).toBe(true);
      expect(component.profileLoadFailed).toBe(false);
    });

    it('offers a retry when the first load fails, and clears it on retry', () => {
      (component as any).accountService = { getMyProfile: () => throwError(() => ({ status: 500 })) };
      component.loadProfile();
      expect(component.profileLoadFailed).toBe(true);
      expect(component.profileLoaded).toBe(false);

      (component as any).restorePendingVerificationState = () => {};
      (component as any).accountService = { getMyProfile: () => of({ id: 1 }) };
      component.loadProfile();
      expect(component.profileLoadFailed).toBe(false);
      expect(component.profileLoaded).toBe(true);
    });

    it('keeps the form up when a later reload fails', () => {
      (component as any).restorePendingVerificationState = () => {};
      (component as any).accountService = { getMyProfile: () => of({ id: 1 }) };
      component.loadProfile();
      (component as any).accountService = { getMyProfile: () => throwError(() => ({ status: 500 })) };
      component.loadProfile();
      expect(component.profileLoaded).toBe(true);
      expect(component.profileLoadFailed).toBe(false);
    });
  });
});
