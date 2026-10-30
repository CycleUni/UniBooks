import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { SettingsComponent } from './settings';
import { RegionService } from '../../core/region.service';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { en } from '../../core/i18n/en';

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

  describe('two-year expiry', () => {
    const tw = { code: 'TW', edu_email_suffix: ['edu.tw'] };
    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    beforeEach(() => {
      (component as any).regionService = { currentRegionObj: () => tw };
    });

    it('offers renewal only in the last 30 days', () => {
      component.verifications = [{ region: 'TW', edu_email: 'a@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(200) }];
      expect(component.renewalDue).toBe(false);
      component.verifications = [{ region: 'TW', edu_email: 'a@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(10) }];
      expect(component.renewalDue).toBe(true);
    });

    it("names the region's lapsed verification only while no live one replaces it", () => {
      component.lapsedVerifications = [{ region: 'TW', edu_email: 'a@ntu.edu.tw', expires_at: '2022-01-01T00:00:00Z' }];
      component.verifications = [];
      expect(component.currentLapsed?.edu_email).toBe('a@ntu.edu.tw');
      component.verifications = [{ region: 'TW', edu_email: 'a@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(700) }];
      expect(component.currentLapsed).toBeNull();
    });

    it('renews through the server without sending any address', () => {
      const renew = vi.fn().mockReturnValue(of({ code: 'acct.sentVerification', edu_email: 'b@ntu.edu.tw' }));
      (component as any).accountService = { renewVerification: renew };
      const mail = vi.spyOn(component as any, 'submitEduVerification');
      component.verifications = [{ region: 'TW', edu_email: 'b@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(5) }];
      component.onVerifyWithOldEmail();
      expect(renew).toHaveBeenCalledWith();
      expect(mail).not.toHaveBeenCalled();
      expect(component.clientVerifyMsg).toBe('acct.sentVerification');
      expect(component.resendCooldownSeconds).toBeGreaterThan(0);
    });

    it("offers a lapsed verification's old address, and a new one when changing", () => {
      const mail = vi.spyOn(component as any, 'submitEduVerification').mockImplementation(() => {});
      component.verifications = [];
      component.lapsedVerifications = [{ region: 'TW', edu_email: 'old@ntu.edu.tw', expires_at: '2022-01-01T00:00:00Z' }];
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
      component.verifications = [{ region: 'TW', edu_email: null, verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(5) }];
      expect(component.renewOldEmail).toBeNull();
    });

    it('mentions Google sign-in only for a Google-linked account signing in with the bound campus address', () => {
      component.verifications = [{ region: 'TW', edu_email: 'me@ntu.edu.tw', verified_at: '2025-01-01T00:00:00Z', expires_at: inDays(5) }];
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
      // The server lists every rule the new password breaks under
      // fields.new_password; each is shown rather than a bare "update failed".
      component.pwdIsError = true;
      (component as any).lastPwdError = {
        error: { error: { code: 'common.errValidation', fields: { new_password: ['acct.errPasswordTooCommon', 'acct.errPasswordNumeric'] } } },
      };

      expect(component.pwdMessage).toContain(en['acct.errPasswordTooCommon']);
      expect(component.pwdMessage).toContain(en['acct.errPasswordNumeric']);
      expect(component.pwdMessage).not.toBe('Update failed. Please try again.');
    });

    it('falls back to its own sentence for a code this locale lacks', () => {
      (component as any).lastPwdError = {
        error: { error: { code: 'acct.errNotTranslatedYet' } },
      };

      expect(component.pwdMessage).toBe('Update failed. Please try again.');
    });

    it('still reports a wrong current password', () => {
      (component as any).lastPwdError = {
        error: { error: { code: 'common.errValidation', fields: { old_password: ['auth.errInvalidPassword'] } } },
      };

      expect(component.pwdMessage).toBe(en['auth.errInvalidPassword']);
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

    it('sends the current password only with a new address', () => {
      const updateProfile = vi.fn(() => of({ id: 1 }));
      (component as any).accountService = { updateProfile, clearProfileCache: vi.fn() };
      (component as any).savedEmail = 'old@example.com';

      component.email = 'OLD@example.com';
      component.emailChangePassword = 'secret';
      component.onUpdateProfile();
      expect(updateProfile).toHaveBeenLastCalledWith(expect.not.objectContaining({ current_password: expect.anything() }));

      component.email = 'new@example.com';
      component.onUpdateProfile();
      expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'new@example.com', current_password: 'secret' }));
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

  describe('passkeys management in SettingsComponent', () => {
    it('loads passkeys on init when supported', () => {
      const mockList = [
        {
          id: 'p1',
          name: 'MacBook Touch ID',
          created_at: '2026-10-17T00:00:00Z',
          last_used_at: null,
          device_type: 'singleDevice' as const,
          backed_up: false,
        },
      ];
      vi.spyOn((component as any).authStore, 'supportsPasskeys').mockReturnValue(true);
      const listSpy = vi
        .spyOn((component as any).accountService, 'listPasskeys')
        .mockReturnValue(of(mockList));

      component.loadPasskeys();

      expect(listSpy).toHaveBeenCalled();
      expect(component.passkeys).toEqual(mockList);
      expect(component.passkeysLoading).toBe(false);
    });

    it('onAddPasskey registers, shows toast, and refreshes list', () => {
      const regSpy = vi
        .spyOn((component as any).accountService, 'passkeyRegister')
        .mockReturnValue(of({ id: 'p2', name: 'Passkey' }));
      const loadSpy = vi.spyOn(component, 'loadPasskeys').mockImplementation(() => {});
      const toastSpy = vi.spyOn((component as any).toast, 'success');

      component.onAddPasskey();

      expect(regSpy).toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
      expect(component.isAddingPasskey).toBe(false);
    });

    it('onAddPasskey suppresses error on user cancellation', () => {
      const cancelErr = new Error('User cancelled');
      cancelErr.name = 'NotAllowedError';
      vi.spyOn((component as any).accountService, 'passkeyRegister').mockReturnValue(
        throwError(() => cancelErr),
      );
      const toastErrorSpy = vi.spyOn((component as any).toast, 'error');

      component.onAddPasskey();

      expect(toastErrorSpy).not.toHaveBeenCalled();
      expect(component.isAddingPasskey).toBe(false);
    });

    it('manages rename state and saves valid name', () => {
      const passkey = {
        id: 'p1',
        name: 'Old Name',
        created_at: '',
        last_used_at: null,
        device_type: 'singleDevice' as const,
        backed_up: false,
      };
      component.startRenamePasskey(passkey);
      expect(component.editingPasskeyId).toBe('p1');
      expect(component.editingPasskeyName).toBe('Old Name');

      component.cancelRenamePasskey();
      expect(component.editingPasskeyId).toBeNull();
      expect(component.editingPasskeyName).toBe('');

      component.startRenamePasskey(passkey);
      component.editingPasskeyName = '   ';
      component.saveRenamePasskey('p1'); // should do nothing for empty/whitespace

      component.editingPasskeyName = 'New Name';
      const renameSpy = vi
        .spyOn((component as any).accountService, 'renamePasskey')
        .mockReturnValue(of({ id: 'p1', name: 'New Name' }));
      const loadSpy = vi.spyOn(component, 'loadPasskeys').mockImplementation(() => {});

      component.saveRenamePasskey('p1');

      expect(renameSpy).toHaveBeenCalledWith('p1', 'New Name');
      expect(loadSpy).toHaveBeenCalled();
      expect(component.editingPasskeyId).toBeNull();
    });

    it('asks danger confirmation and deletes passkey', async () => {
      const passkey = {
        id: 'p1',
        name: 'My Key',
        created_at: '',
        last_used_at: null,
        device_type: 'singleDevice' as const,
        backed_up: false,
      };
      const askSpy = vi.spyOn((component as any).confirms, 'askDanger').mockResolvedValue(true);
      const deleteSpy = vi
        .spyOn((component as any).accountService, 'deletePasskey')
        .mockReturnValue(of(undefined));
      const loadSpy = vi.spyOn(component, 'loadPasskeys').mockImplementation(() => {});

      await component.onDeletePasskey(passkey);

      expect(askSpy).toHaveBeenCalled();
      expect(deleteSpy).toHaveBeenCalledWith('p1');
      expect(loadSpy).toHaveBeenCalled();
    });

    it('displays provider when different from name, and handles icon rendering and errors', () => {
      const fixture = TestBed.createComponent(SettingsComponent);
      const comp = fixture.componentInstance;
      vi.spyOn(comp, 'loadProfile').mockImplementation(() => {});
      vi.spyOn(comp, 'loadPasskeys').mockImplementation(() => {});
      vi.spyOn((comp as any).authStore, 'supportsPasskeys').mockReturnValue(true);
      comp.profileLoaded = true;
      comp.passkeysLoading = false;

      comp.passkeys = [
        {
          id: 'p1',
          name: 'My Custom Passkey',
          provider: 'YubiKey 5 NFC',
          icon_light: '/passkey-icons/yubi.light.svg',
          icon_dark: '/passkey-icons/yubi.dark.svg',
          created_at: '2026-10-17T00:00:00Z',
          last_used_at: null,
          device_type: 'singleDevice',
          backed_up: false,
        },
        {
          id: 'p2',
          name: 'Passkey (synced)',
          provider: null,
          icon_light: null,
          icon_dark: null,
          created_at: '2026-10-17T00:00:00Z',
          last_used_at: null,
          device_type: 'multiDevice',
          backed_up: true,
        },
        {
          id: 'p3',
          name: 'Chrome on Mac',
          provider: 'Chrome on Mac',
          icon_light: '/passkey-icons/chrome.light.svg',
          icon_dark: null,
          created_at: '2026-10-17T00:00:00Z',
          last_used_at: null,
          device_type: 'singleDevice',
          backed_up: false,
        },
      ];
      fixture.detectChanges();

      const items = fixture.nativeElement.querySelectorAll('.passkey-item');
      expect(items.length).toBe(3);

      // Item 1: provider differs from name -> .passkey-provider shown, picture shown
      const p1Provider = items[0].querySelector('.passkey-provider');
      expect(p1Provider).not.toBeNull();
      expect(p1Provider.textContent.trim()).toBe('YubiKey 5 NFC');
      const p1Picture = items[0].querySelector('picture');
      expect(p1Picture).not.toBeNull();
      const p1Source = p1Picture.querySelector('source');
      expect(p1Source.getAttribute('srcset')).toBe('/passkey-icons/yubi.dark.svg');
      const p1Img = p1Picture.querySelector('img');
      expect(p1Img.getAttribute('src')).toBe('/passkey-icons/yubi.light.svg');

      // Item 2: provider is null, no icons -> fallback SVG shown, no provider line
      expect(items[1].querySelector('.passkey-provider')).toBeNull();
      expect(items[1].querySelector('picture')).toBeNull();
      expect(items[1].querySelector('.passkey-icon-fallback')).not.toBeNull();

      // Item 3: provider equals name -> no provider line, picture shown
      expect(items[2].querySelector('.passkey-provider')).toBeNull();
      expect(items[2].querySelector('picture')).not.toBeNull();

      // Test icon error on Item 1 -> falls back to generic key SVG
      comp.onPasskeyIconError('p1');
      fixture.detectChanges();
      expect(items[0].querySelector('picture')).toBeNull();
      expect(items[0].querySelector('.passkey-icon-fallback')).not.toBeNull();
    });
  });
});
