import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID, signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { GoogleAuthService } from './google-auth.service';
import { AuthStore } from '../auth.store';
import { I18nService } from '../i18n.service';
import { ThemeService } from './theme.service';
import { ToastService } from './toast.service';

// The loading states the auth page and One Tap show around a Google sign-in.
describe('GoogleAuthService sign-in state', () => {
  let service: GoogleAuthService;
  let isAuthenticated: ReturnType<typeof signal<boolean>>;
  let reply: Subject<unknown>;
  let toast: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sessionStorage.setItem('google_one_tap_done', '1');
    isAuthenticated = signal(false);
    reply = new Subject();
    toast = { info: vi.fn(() => 7), error: vi.fn(), dismiss: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        {
          provide: AuthStore,
          useValue: { isAuthenticated, loginWithGoogle: vi.fn(() => reply), getAuthConfig: () => of({}) },
        },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: () => null, lang: signal('zh-TW') } },
        { provide: ThemeService, useValue: { resolved: signal('light') } },
        { provide: ToastService, useValue: toast },
      ],
    });
    service = TestBed.inject(GoogleAuthService);
  });

  afterEach(() => {
    sessionStorage.removeItem('google_one_tap_done');
    vi.useRealTimers();
  });

  const signIn = () => (service as any).handleGoogleCredential({ credential: 'jwt' });

  it('is signing in while the backend answers, and stays so on success', () => {
    signIn();
    expect(service.signingIn()).toBe(true);

    isAuthenticated.set(true);
    reply.next({});
    expect(service.signingIn()).toBe(true);
  });

  it('clears a finished sign-in once the member signs out', () => {
    signIn();
    isAuthenticated.set(true);
    reply.next({});
    TestBed.tick();
    isAuthenticated.set(false);
    TestBed.tick();
    expect(service.signingIn()).toBe(false);
  });

  it('stops signing in on a failure', () => {
    signIn();
    reply.error({ status: 403 });
    expect(service.signingIn()).toBe(false);
    expect(toast.error).toHaveBeenCalled();
  });

  it('stops signing in when a reply signs no one in', () => {
    signIn();
    reply.next({});
    expect(service.signingIn()).toBe(false);
  });

  it('tells a One Tap sign-in away from the auth page with a toast, dismissed when done', () => {
    signIn();
    expect(toast.info).toHaveBeenCalledWith('auth.googleSigningIn', 0);
    reply.error({ status: 500 });
    expect(toast.dismiss).toHaveBeenCalledWith(7);
  });

  it('leaves the toast to the auth page, which shows it on its button', () => {
    const el = document.createElement('div');
    el.id = 'google-btn';
    document.body.appendChild(el);
    try {
      service.renderButton('google-btn');
      signIn();
      expect(toast.info).not.toHaveBeenCalled();
    } finally {
      el.remove();
    }
  });

  it('reports a Google script that cannot load, without an unhandled rejection', async () => {
    const failed = Promise.reject(new Event('error'));
    (service as any).loadGoogleScript = () => failed;
    (service as any).googleClientId = 'client-id';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      service.renderButton('google-btn');
      await failed.catch(() => {});
      await Promise.resolve();
      expect(logged).toHaveBeenCalledWith('Failed to load Google SDK', expect.any(Event));
      expect(service.buttonReady()).toBe(false);
      expect(service.buttonFailed()).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it('shows the chooser opening for a while after a press, since GIS never says it was dismissed', () => {
    vi.useFakeTimers();
    (service as any).onButtonPressed();
    expect(service.opening()).toBe(true);
    vi.advanceTimersByTime(GoogleAuthService.OPENING_MS);
    expect(service.opening()).toBe(false);
  });

  it('drops the opening state once a credential arrives', () => {
    (service as any).onButtonPressed();
    signIn();
    expect(service.opening()).toBe(false);
  });

  describe('renderCampusVerifyButton', () => {
    let mockGoogle: any;
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement('div');
      container.id = 'test-campus-btn';
      document.body.appendChild(container);

      mockGoogle = {
        accounts: {
          id: {
            initialize: vi.fn(),
            renderButton: vi.fn(),
          },
        },
      };
      (window as any).google = mockGoogle;
      (service as any).googleClientId = 'test-client-id';
      (service as any).loadGoogleScript = () => Promise.resolve();
    });

    afterEach(() => {
      container.remove();
      delete (window as any).google;
    });

    it('initializes GIS with nonce, hd hint, and renders button', async () => {
      const onCredential = vi.fn();
      const onReady = vi.fn();
      const teardown = service.renderCampusVerifyButton(container, {
        nonce: 'test-nonce-123',
        hd: 'ntu.edu.tw',
        onCredential,
        onReady,
      });

      await Promise.resolve();

      expect(mockGoogle.accounts.id.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: 'test-client-id',
          nonce: 'test-nonce-123',
          hd: 'ntu.edu.tw',
          use_fedcm_for_button: false,
        }),
      );
      expect(mockGoogle.accounts.id.renderButton).toHaveBeenCalledWith(
        container,
        expect.objectContaining({
          size: 'large',
          type: 'standard',
          text: 'continue_with',
        }),
      );
      expect(onReady).toHaveBeenCalled();
      teardown();
    });

    it('invokes onCredential when GIS returns a credential', async () => {
      const onCredential = vi.fn();
      const teardown = service.renderCampusVerifyButton(container, {
        nonce: 'test-nonce-123',
        onCredential,
      });

      await Promise.resolve();

      const initCall = mockGoogle.accounts.id.initialize.mock.calls[0][0];
      initCall.callback({ credential: 'campus-jwt-token' });

      expect(onCredential).toHaveBeenCalledWith('campus-jwt-token');
      teardown();
    });

    it('invokes onError when Google SDK is unavailable or script fails to load', async () => {
      (service as any).loadGoogleScript = () => Promise.reject(new Error('Network error'));
      const onError = vi.fn();

      const teardown = service.renderCampusVerifyButton(container, {
        nonce: 'test-nonce',
        onCredential: vi.fn(),
        onError,
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      teardown();
    });

    it('re-initializes GIS when rendering sign-in button after campus button', async () => {
      const teardown = service.renderCampusVerifyButton(container, {
        nonce: 'campus-nonce',
        onCredential: vi.fn(),
      });
      await Promise.resolve();

      expect(mockGoogle.accounts.id.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ nonce: 'campus-nonce' }),
      );

      service.renderButton('test-campus-btn');
      await Promise.resolve();

      // Sign-in re-initializes without nonce
      const lastInitCall = mockGoogle.accounts.id.initialize.mock.calls.at(-1)[0];
      expect(lastInitCall.nonce).toBeUndefined();
      teardown();
    });
  });
});
