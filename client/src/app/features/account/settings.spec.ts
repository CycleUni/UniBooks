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
        AccountService,
      ],
    });

    const fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
  });

  describe('verification summary row', () => {
    beforeEach(() => {
      (component as any).regionService = {
        currentRegionObj: () => ({ code: 'TW', localized_name: 'Taiwan' }),
        region: () => 'tw',
      };
      (component as any).authStore = {
        mustVerifyIn: vi.fn().mockReturnValue(false),
        supportsPasskeys: () => false,
      };
    });

    it('identifies verified state and school name', () => {
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

    it('identifies unverified state', () => {
      component.verifications = [];
      expect(component.isVerified).toBe(false);
      expect(component.currentVerifiedSchoolName).toBe('');
    });

    it('reports mustVerify status from authStore', () => {
      component.verifications = [];
      expect(component.mustVerify).toBe(false);

      (component as any).authStore.mustVerifyIn = vi.fn().mockReturnValue(true);
      expect(component.mustVerify).toBe(true);
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

    it('prefers the client-side empty-fields error to an older server error', () => {
      component.lastPwdError = { error: { error: { code: 'auth.errWrongPassword' } } };
      component.clientPwdMsg = 'auth.errFillAll';
      expect(component.pwdMessage).toBe(en['auth.errFillAll']);
    });
  });

  describe('changing the sign-in email', () => {
    beforeEach(() => {
      (component as any).accountService = {
        getMyProfile: () => of({ email: 'current@example.com', first_name: '', last_name: '' }),
        updateProfile: vi.fn().mockReturnValue(of({ code: 'acct.emailChangePending' })),
        clearProfileCache: vi.fn(),
      };
      component.loadProfile();
    });

    it('flags emailChanged only when the field differs from what loaded', () => {
      expect(component.emailChanged).toBe(false);
      component.email = 'Current@example.com';
      expect(component.emailChanged).toBe(false);
      component.email = 'new@example.com';
      expect(component.emailChanged).toBe(true);
    });

    it('sends the current password only when the email changed', () => {
      const update = vi.fn().mockReturnValue(of({ code: 'acct.profileSaved' }));
      (component as any).accountService.updateProfile = update;

      component.firstName = 'Alice';
      component.onUpdateProfile();
      expect(update).toHaveBeenCalledWith(expect.not.objectContaining({ current_password: expect.anything() }));

      component.email = 'new@example.com';
      component.emailChangePassword = 'secret-password';
      component.onUpdateProfile();
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        email: 'new@example.com',
        current_password: 'secret-password',
      }));
    });

    it('names the pending state when the server answers with emailChangePending', () => {
      component.email = 'new@example.com';
      component.emailChangePassword = 'secret-password';
      component.onUpdateProfile();

      expect(component.clientSettingsMsg).toBe('acct.emailChangePending');
      expect((component as any).accountService.clearProfileCache).toHaveBeenCalled();
    });

    it('lets the user cancel an in-flight email change', () => {
      const cancel = vi.fn().mockReturnValue(of({}));
      (component as any).accountService.cancelEmailChange = cancel;
      component.pendingEmail = 'new@example.com';

      component.onCancelEmailChange();
      expect(cancel).toHaveBeenCalled();
      expect(component.pendingEmail).toBeNull();
    });
  });

  describe('hiding the Google avatar', () => {
    it('updates showAvatar straight away and flips it back if the save fails', () => {
      const update = vi.fn().mockReturnValue(throwError(() => ({ status: 500 })));
      (component as any).accountService = { updateProfile: update };
      (component as any).toast = { error: vi.fn() };
      component.showAvatar = true;

      const checkbox = { checked: false } as HTMLInputElement;
      component.setShowAvatar(checkbox);

      expect(update).toHaveBeenCalledWith({ show_avatar: false });
      expect(component.showAvatar).toBe(true);
      expect(checkbox.checked).toBe(true);
      expect(component.savingShowAvatar).toBe(false);
    });

    it('does nothing when the change event fires without a value change', () => {
      const update = vi.fn();
      (component as any).accountService = { updateProfile: update };
      component.showAvatar = true;

      const checkbox = { checked: true } as HTMLInputElement;
      component.setShowAvatar(checkbox);

      expect(update).not.toHaveBeenCalled();
    });

    it('keeps the new value on success', () => {
      const update = vi.fn().mockReturnValue(of({}));
      (component as any).accountService = { updateProfile: update };
      (component as any).toast = { success: vi.fn() };
      component.showAvatar = true;

      const checkbox = { checked: false } as HTMLInputElement;
      component.setShowAvatar(checkbox);

      expect(component.showAvatar).toBe(false);
      expect(component.savingShowAvatar).toBe(false);
    });
  });

  describe('first profile load', () => {
    it('holds the form back until the profile arrives', () => {
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

      (component as any).accountService = { getMyProfile: () => of({ id: 1 }) };
      component.loadProfile();
      expect(component.profileLoadFailed).toBe(false);
      expect(component.profileLoaded).toBe(true);
    });

    it('keeps the form up when a later reload fails', () => {
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
      (component as any).authStore = {
        supportsPasskeys: () => true,
        updateUser: vi.fn(),
      };
      (component as any).accountService = {
        listPasskeys: vi.fn().mockReturnValue(of(mockList)),
        getMyProfile: () => of({}),
      };
      (component as any).metadataService = { getMetadata: () => of({}) };

      component.ngOnInit();
      expect(component.passkeys).toEqual(mockList);
      expect(component.passkeysLoading).toBe(false);
    });

    it('renders provider and icon conditionally according to design', () => {
      const mockList = [
        {
          id: 'p1',
          name: 'iPhone 15',
          provider: 'Apple Keychain',
          icon_light: 'https://example.com/apple-light.png',
          icon_dark: 'https://example.com/apple-dark.png',
          created_at: '2026-10-17T00:00:00Z',
          last_used_at: '2026-10-18T00:00:00Z',
          device_type: 'multiDevice' as const,
          backed_up: true,
        },
        {
          id: 'p2',
          name: 'Security Key',
          provider: null,
          icon_light: null,
          icon_dark: null,
          created_at: '2026-10-17T00:00:00Z',
          last_used_at: null,
          device_type: 'singleDevice' as const,
          backed_up: false,
        },
        {
          id: 'p3',
          name: 'Google Password Manager',
          provider: 'Google Password Manager',
          icon_light: 'https://example.com/google.png',
          icon_dark: null,
          created_at: '2026-10-17T00:00:00Z',
          last_used_at: null,
          device_type: 'multiDevice' as const,
          backed_up: true,
        },
      ];

      const fixture = TestBed.createComponent(SettingsComponent);
      const comp = fixture.componentInstance;

      (comp as any).authStore = {
        supportsPasskeys: () => true,
        updateUser: vi.fn(),
      };
      (comp as any).accountService = {
        listPasskeys: vi.fn().mockReturnValue(of(mockList)),
        getMyProfile: () => of({}),
      };
      (comp as any).metadataService = { getMetadata: () => of({}) };
      fixture.detectChanges();

      comp.ngOnInit();
      comp.profileLoaded = true;
      fixture.detectChanges();

      const items = fixture.nativeElement.querySelectorAll('.passkey-item');
      expect(items.length).toBe(3);

      // Item 1: distinct provider and icons -> picture element shown, provider text rendered
      expect(items[0].querySelector('.passkey-provider').textContent).toContain('Apple Keychain');
      expect(items[0].querySelector('picture')).not.toBeNull();
      expect(items[0].querySelector('.passkey-icon-fallback')).toBeNull();

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
