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
});
