import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { signal } from '@angular/core';
import { AuthStore, isUserCancellation, PasskeyItem, webauthnBrowser } from './auth.store';
import { RegionLinkService } from './region-link.service';
import { RegionService } from './region.service';
import { GoogleAnalyticsService } from './services/google-analytics.service';

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('isUserCancellation', () => {
  it('returns false for non-error or unrelated errors', () => {
    expect(isUserCancellation(null)).toBe(false);
    expect(isUserCancellation(undefined)).toBe(false);
    expect(isUserCancellation(new Error('Network error'))).toBe(false);
  });

  it('identifies NotAllowedError directly or inside cause', () => {
    const err = new Error('The operation either timed out or was not allowed');
    err.name = 'NotAllowedError';
    expect(isUserCancellation(err)).toBe(true);

    const wrapped = new Error('Wrapper');
    wrapped.cause = err;
    expect(isUserCancellation(wrapped)).toBe(true);
  });

  it('identifies AbortError directly or inside cause', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isUserCancellation(err)).toBe(true);

    const wrapped = new Error('Wrapper');
    wrapped.cause = err;
    expect(isUserCancellation(wrapped)).toBe(true);
  });

  it('identifies ERROR_CEREMONY_ABORTED code directly or in cause', () => {
    const err = { code: 'ERROR_CEREMONY_ABORTED' };
    expect(isUserCancellation(err)).toBe(true);

    const wrapped = { cause: { code: 'ERROR_CEREMONY_ABORTED' } };
    expect(isUserCancellation(wrapped)).toBe(true);
  });
});

describe('AuthStore Passkey API', () => {
  let authStore: AuthStore;
  let httpMock: HttpTestingController;
  let mockGa: { trackLogin: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    mockGa = { trackLogin: vi.fn() };

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule],
      providers: [
        AuthStore,
        RegionLinkService,
        { provide: RegionService, useValue: { region: signal('tw') } },
        { provide: GoogleAnalyticsService, useValue: mockGa },
      ],
    });

    authStore = TestBed.inject(AuthStore);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    localStorage.clear();
    httpMock.verify();
    TestBed.resetTestingModule();
  });

  describe('supportsPasskeys', () => {
    it('returns true when browserSupportsWebAuthn is true', () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(true);
      expect(authStore.supportsPasskeys()).toBe(true);
    });

    it('returns false when browserSupportsWebAuthn is false', () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(false);
      expect(authStore.supportsPasskeys()).toBe(false);
    });
  });

  describe('passkeyLogin', () => {
    it('errors immediately if passkeys not supported', () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(false);

      let err: any;
      authStore.passkeyLogin().subscribe({
        error: (e) => (err = e),
      });

      expect(err).toBeDefined();
      expect(err.message).toBe('WebAuthn not supported');
    });

    it('requests options, starts authentication, verifies response and sets session', async () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(true);
      const mockCred = {
        id: 'cred-123',
        rawId: 'raw-123',
        response: { clientDataJSON: 'xyz' },
        type: 'public-key',
      };
      vi.spyOn(webauthnBrowser, 'startAuthentication').mockResolvedValue(mockCred as any);

      let result: any;
      authStore.passkeyLogin().subscribe((res) => (result = res));

      // 1. Login options request
      const optReq = httpMock.expectOne('/auth/passkeys/login/options');
      expect(optReq.request.method).toBe('POST');
      optReq.flush({
        challenge_id: 'chal-abc',
        options: { challenge: 'server-challenge', rpId: 'localhost' },
      });

      // Let startAuthentication promise settle
      await flushMicrotasks();

      expect(webauthnBrowser.startAuthentication).toHaveBeenCalledWith({
        optionsJSON: { challenge: 'server-challenge', rpId: 'localhost' },
      });

      // 2. Login verify request
      const verifyReq = httpMock.expectOne('/auth/passkeys/login/verify');
      expect(verifyReq.request.method).toBe('POST');
      expect(verifyReq.request.body).toEqual({
        challenge_id: 'chal-abc',
        response: mockCred,
      });

      verifyReq.flush({ code: 'auth.loginSuccess', user_id: 'user-1' });

      expect(result).toEqual({ code: 'auth.loginSuccess', user_id: 'user-1' });
      expect(mockGa.trackLogin).toHaveBeenCalledWith('Passkey');
      expect(authStore.isAuthenticated()).toBe(true);
    });

    it('supports useBrowserAutofill option in passkeyLogin', async () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(true);
      const mockCred = {
        id: 'cred-auto',
        rawId: 'raw-auto',
        response: { clientDataJSON: 'xyz' },
        type: 'public-key',
      };
      vi.spyOn(webauthnBrowser, 'startAuthentication').mockResolvedValue(mockCred as any);

      authStore.passkeyLogin({ useBrowserAutofill: true }).subscribe();

      const optReq = httpMock.expectOne('/auth/passkeys/login/options');
      optReq.flush({
        challenge_id: 'chal-auto',
        options: { challenge: 'auto-chal', rpId: 'localhost' },
      });

      await flushMicrotasks();

      expect(webauthnBrowser.startAuthentication).toHaveBeenCalledWith({
        optionsJSON: { challenge: 'auto-chal', rpId: 'localhost' },
        useBrowserAutofill: true,
      });

      const verifyReq = httpMock.expectOne('/auth/passkeys/login/verify');
      verifyReq.flush({ code: 'auth.loginSuccess', user_id: 'user-auto' });

      expect(authStore.isAuthenticated()).toBe(true);
    });
  });

  describe('passkeyRegister', () => {
    it('errors immediately if passkeys not supported', () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(false);

      let err: any;
      authStore.passkeyRegister().subscribe({
        error: (e) => (err = e),
      });

      expect(err).toBeDefined();
      expect(err.message).toBe('WebAuthn not supported');
    });

    it('requests registration options, starts registration, and verifies', async () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(true);
      const mockRegResponse = { id: 'new-cred-id', rawId: 'raw', response: {}, type: 'public-key' };
      vi.spyOn(webauthnBrowser, 'startRegistration').mockResolvedValue(mockRegResponse as any);

      let result: any;
      authStore.passkeyRegister('My MacBook').subscribe((res) => (result = res));

      // 1. Options request
      const optReq = httpMock.expectOne('/auth/passkeys/register/options');
      expect(optReq.request.method).toBe('POST');
      optReq.flush({
        challenge_id: 'chal-reg-1',
        options: { challenge: 'reg-chal', rp: { name: 'UniBooks' } },
      });

      await flushMicrotasks();

      expect(webauthnBrowser.startRegistration).toHaveBeenCalledWith({
        optionsJSON: { challenge: 'reg-chal', rp: { name: 'UniBooks' } },
      });

      // 2. Verify request
      const verifyReq = httpMock.expectOne('/auth/passkeys/register/verify');
      expect(verifyReq.request.method).toBe('POST');
      expect(verifyReq.request.body).toEqual({
        challenge_id: 'chal-reg-1',
        response: mockRegResponse,
        name: 'My MacBook',
      });

      verifyReq.flush({ id: 'new-cred-id', name: 'My MacBook' });

      expect(result).toEqual({ id: 'new-cred-id', name: 'My MacBook' });
    });
  });

  describe('two-step sign-in', () => {
    it('login: a passkey challenge after the password is answered with the passkey, then signs in', async () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(true);
      const assertion = { id: 'cred-1', rawId: 'raw-1', response: {}, type: 'public-key' };
      vi.spyOn(webauthnBrowser, 'startAuthentication').mockResolvedValue(assertion as any);

      let result: any;
      authStore.login('a@b.c', 'pw').subscribe((res) => (result = res));
      httpMock.expectOne('/auth/login').flush({
        code: 'auth.passkeyRequired',
        challenge_id: 'chal-2fa',
        options: { challenge: 'c', allowCredentials: [{ id: 'cred-1' }] },
      });
      await flushMicrotasks();

      expect(authStore.isAuthenticated()).toBe(false);
      const verify = httpMock.expectOne('/auth/passkeys/2fa/verify');
      expect(verify.request.body).toEqual({ challenge_id: 'chal-2fa', response: assertion });
      verify.flush({ code: 'auth.loginSuccess', user_id: 'u1' });

      expect(result.code).toBe('auth.loginSuccess');
      expect(authStore.isAuthenticated()).toBe(true);
      expect(mockGa.trackLogin).toHaveBeenCalledWith('Password');
    });

    it('login: a cancelled passkey prompt fails with the passkey sign-in message', async () => {
      vi.spyOn(webauthnBrowser, 'browserSupportsWebAuthn').mockReturnValue(true);
      const cancelled = new Error('cancelled');
      cancelled.name = 'NotAllowedError';
      vi.spyOn(webauthnBrowser, 'startAuthentication').mockRejectedValue(cancelled);

      let error: any;
      authStore.login('a@b.c', 'pw').subscribe({ error: (e) => (error = e) });
      httpMock.expectOne('/auth/login').flush({ code: 'auth.passkeyRequired', challenge_id: 'x', options: {} });
      await flushMicrotasks();

      expect(error.error.error.code).toBe('auth.errPasskeyLogin');
      expect(authStore.isAuthenticated()).toBe(false);
    });

    it('setPasskeyTwoStep sends PUT /auth/passkeys/2fa', () => {
      authStore.setPasskeyTwoStep(true).subscribe();
      const req = httpMock.expectOne('/auth/passkeys/2fa');
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ enabled: true });
      req.flush({ passkey_2fa: true });
    });
  });

  describe('Passkey management endpoints', () => {
    it('cancelPasskey calls WebAuthnAbortService.cancelCeremony', () => {
      const cancelSpy = vi.spyOn(webauthnBrowser.WebAuthnAbortService, 'cancelCeremony');
      authStore.cancelPasskey();
      expect(cancelSpy).toHaveBeenCalled();
    });

    it('listPasskeys calls GET /auth/passkeys', () => {
      const mockList: PasskeyItem[] = [
        {
          id: 'k1',
          name: 'Chrome on macOS',
          aaguid: 'test-aaguid',
          provider: 'Google Password Manager',
          icon_light: '/passkey-icons/test-aaguid.light.svg',
          icon_dark: '/passkey-icons/test-aaguid.dark.svg',
          created_at: '2026-10-17T10:00:00Z',
          last_used_at: null,
          device_type: 'multiDevice',
          backed_up: true,
        },
      ];

      let list: PasskeyItem[] | undefined;
      authStore.listPasskeys().subscribe((res) => (list = res));

      const req = httpMock.expectOne('/auth/passkeys');
      expect(req.request.method).toBe('GET');
      req.flush(mockList);

      expect(list).toEqual(mockList);
    });

    it('renamePasskey calls PATCH /auth/passkeys/:id', () => {
      let result: any;
      authStore.renamePasskey('k1', 'New Name').subscribe((res) => (result = res));

      const req = httpMock.expectOne('/auth/passkeys/k1');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ name: 'New Name' });
      req.flush({ id: 'k1', name: 'New Name' });

      expect(result).toEqual({ id: 'k1', name: 'New Name' });
    });

    it('deletePasskey calls DELETE /auth/passkeys/:id', () => {
      let completed = false;
      authStore.deletePasskey('k1').subscribe(() => (completed = true));

      const req = httpMock.expectOne('/auth/passkeys/k1');
      expect(req.request.method).toBe('DELETE');
      req.flush(null);

      expect(completed).toBe(true);
    });
  });
});
