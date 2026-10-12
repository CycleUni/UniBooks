import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { By } from '@angular/platform-browser';

import { AuthFormComponent } from './auth-form.component';
import { AuthStore } from '../../core/auth.store';
import { GoogleAuthService } from '../../core/services/google-auth.service';
import { I18nService } from '../../core/i18n.service';
import { ThemeService } from '../../core/services/theme.service';
import { RegionService } from '../../core/region.service';

/** The only keys the i18n double "knows". Everything else resolves to null,
 *  standing in for a backend error code no locale declares. */
const KNOWN_KEYS: Record<string, string> = {
  'auth.errInvalidCredentials': '信箱或密碼錯誤',
};

describe('AuthFormComponent', () => {
  let fixture: ComponentFixture<AuthFormComponent>;
  let component: AuthFormComponent;
  let mockAuth: any;
  let mockGoogle: any;
  let mockRouter: any;
  let isAuthenticated: ReturnType<typeof signal<boolean>>;
  let queryParams: Record<string, string>;
  let currentRegionObj: ReturnType<typeof signal<any>>;

  const build = (mode: 'login' | 'register') => {
    fixture = TestBed.createComponent(AuthFormComponent);
    component = fixture.componentInstance;
    component.mode = mode;
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(() => {
    isAuthenticated = signal(false);
    queryParams = {};
    currentRegionObj = signal({ code: 'TW', edu_email_suffix: ['.edu.tw'] });
    mockAuth = {
      isAuthenticated,
      isLoggedIn: () => isAuthenticated(),
      login: vi.fn().mockReturnValue(of({})),
      register: vi.fn().mockReturnValue(of({}))
    };
    mockGoogle = { renderButton: vi.fn(), buttonReady: signal(true), opening: signal(false), signingIn: signal(false) };
    mockRouter = {
      navigate: vi.fn().mockResolvedValue(true),
      navigateByUrl: vi.fn().mockResolvedValue(true),
      getCurrentNavigation: vi.fn().mockReturnValue(null),
      // RouterLink inside RegionLinkDirective only needs these to build hrefs.
      createUrlTree: vi.fn().mockReturnValue({}),
      serializeUrl: vi.fn().mockReturnValue('/'),
      events: of()
    };

    TestBed.configureTestingModule({
      imports: [AuthFormComponent],
      providers: [
        { provide: AuthStore, useValue: mockAuth },
        { provide: GoogleAuthService, useValue: mockGoogle },
        { provide: Router, useValue: mockRouter },
        { provide: RegionService, useValue: { region: () => 'tw', currentRegionObj } },
        // tOrNull mirrors the service: null for anything this double does not
        // "translate", which is what tells a real error code from one no locale
        // declares. Returning the key here instead would hide the guard.
        {
          provide: I18nService,
          useValue: {
            t: (k: string, params?: Record<string, unknown>) => params ? `${k} ${JSON.stringify(params)}` : k,
            tOrNull: (k: unknown) => (typeof k === 'string' && k in KNOWN_KEYS ? KNOWN_KEYS[k] : null),
            lang: signal('zh-TW'),
          },
        },
        { provide: ThemeService, useValue: { resolved: signal('light'), mode: signal('system') } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } }
        }
      ]
    });
  });

  it('renders the login form with the Google button container', () => {
    build('login');
    expect(fixture.nativeElement.querySelector('#google-btn')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('auth.studentLogin');
  });

  it('renders the register form with the Google button container too', () => {
    // The backend creates the account for a new Google address, so sign-up
    // offers the same button as sign-in.
    build('register');
    expect(fixture.nativeElement.querySelector('#google-btn')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('auth.registerTitle');
  });

  it('asks the Google SDK to render its button on both the login and register pages', async () => {
    build('login');
    await new Promise(r => setTimeout(r, 0));
    expect(mockGoogle.renderButton).toHaveBeenCalledWith('google-btn');

    mockGoogle.renderButton.mockClear();
    build('register');
    await new Promise(r => setTimeout(r, 0));
    expect(mockGoogle.renderButton).toHaveBeenCalledWith('google-btn');
  });

  // Google draws the button itself, so nothing on the page used to answer
  // a press or the wait after picking an account.
  describe('Google loading states', () => {
    const q = (sel: string) => fixture.nativeElement.querySelector(sel);

    it('holds the button\'s place until Google has drawn it', () => {
      mockGoogle.buttonReady.set(false);
      build('login');
      expect(q('.google-placeholder')).toBeTruthy();

      mockGoogle.buttonReady.set(true);
      fixture.detectChanges();
      expect(q('.google-placeholder')).toBeNull();
    });

    it('shows a spinner, letting clicks through, while the account chooser opens', () => {
      build('login');
      expect(q('.google-veil')).toBeNull();

      mockGoogle.opening.set(true);
      fixture.detectChanges();
      expect(q('.google-veil .spinner')).toBeTruthy();
      expect(q('.google-veil').classList).not.toContain('blocking');
    });

    it('says it is signing in, and blocks a second press, while the backend answers', () => {
      build('register');
      mockGoogle.signingIn.set(true);
      fixture.detectChanges();
      expect(q('.google-veil').classList).toContain('blocking');
      expect(q('.google-veil').textContent).toContain('auth.googleSigningIn');
      expect(q('.google-wrap').getAttribute('aria-busy')).toBe('true');
    });
  });

  describe('field semantics', () => {
    const field = (id: string): HTMLInputElement => fixture.nativeElement.querySelector(`input#${id}`);

    it('ties each login label to its field and marks the fields for password managers', () => {
      build('login');
      const email = field('login-email');
      const password = field('login-password');
      expect(email.labels?.[0].textContent).toContain('auth.emailLabel');
      expect(email.type).toBe('email');
      expect(email.getAttribute('autocomplete')).toBe('username');
      expect(password.labels?.[0].textContent).toContain('auth.passwordLabel');
      expect(password.type).toBe('password');
      expect(password.getAttribute('autocomplete')).toBe('current-password');
    });

    it('ties each register label to its field with sign-up autocomplete tokens', () => {
      build('register');
      const expected: Record<string, [string, string]> = {
        'register-last-name': ['auth.lastNameLabel', 'family-name'],
        'register-first-name': ['auth.firstNameLabel', 'given-name'],
        'register-email': ['auth.registerEmailLabel', 'email'],
        'register-password': ['auth.setPasswordLabel', 'new-password'],
        'register-confirm-password': ['auth.confirmPasswordLabel', 'new-password'],
      };
      for (const [id, [label, autocomplete]] of Object.entries(expected)) {
        expect(field(id).labels?.[0].textContent, id).toContain(label);
        expect(field(id).getAttribute('autocomplete'), id).toBe(autocomplete);
      }
      expect(field('register-email').type).toBe('email');
    });
  });

  describe('form message', () => {
    const message = (): HTMLElement | null => fixture.nativeElement.querySelector('#auth-msg');
    const submitButton = (): HTMLElement => fixture.nativeElement.querySelector('ui-button');
    // Through the button's output rather than calling onLogin() directly: the
    // component is OnPush by default, and it is the template event that marks
    // the view for re-render, exactly as a real click does.
    const submit = () => {
      fixture.debugElement.query(By.css('ui-button')).triggerEventHandler('onClick');
      fixture.detectChanges();
    };

    it('shows an empty-login error right above the submit button and before the Google button', () => {
      build('login');
      submit();

      const msg = message()!;
      expect(msg.textContent).toContain('auth.errFillEmailPassword');
      expect(msg.getAttribute('role')).toBe('alert');
      expect(msg.nextElementSibling).toBe(submitButton());
      const google = fixture.nativeElement.querySelector('#google-btn');
      expect(msg.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('points the fields at the message only while one is showing', () => {
      build('login');
      const email = () => fixture.nativeElement.querySelector('input#login-email') as HTMLInputElement;
      expect(email().hasAttribute('aria-describedby')).toBe(false);

      submit();
      expect(email().getAttribute('aria-describedby')).toBe('auth-msg');
      expect(fixture.nativeElement.querySelector('input#login-password').getAttribute('aria-describedby')).toBe('auth-msg');
    });

    it('does the same on register, keeping the email field\'s own hint', () => {
      build('register');
      const email = () => fixture.nativeElement.querySelector('input#register-email') as HTMLInputElement;
      expect(email().getAttribute('aria-describedby')).toBe('register-email-hint');

      submit();
      expect(message()!.textContent).toContain('auth.errFillAll');
      expect(message()!.nextElementSibling).toBe(submitButton());
      expect(email().getAttribute('aria-describedby')).toBe('register-email-hint auth-msg');
      expect(fixture.nativeElement.querySelector('input#register-last-name').getAttribute('aria-describedby'))
        .toBe('register-name-hint auth-msg');
    });

    it('announces the post-sign-up notice politely rather than as an alert', () => {
      mockRouter.getCurrentNavigation.mockReturnValue({
        extras: { state: { registeredEmail: 'new@example.com', registeredNotice: 'auth.registerSuccess' } }
      });
      build('login');
      expect(message()!.getAttribute('role')).toBe('status');
    });
  });

  describe('campus email hint', () => {
    const hint = () => fixture.nativeElement.querySelector('#register-email-hint') as HTMLElement;

    it('names the region\'s campus suffixes', () => {
      currentRegionObj.set({ code: 'HK', edu_email_suffix: ['.edu.hk', '.hk'] });
      build('register');
      expect(hint().textContent).toContain('auth.campusEmailHint');
      expect(hint().textContent).toContain('(.edu.hk, .hk)');
    });

    it('falls back to the generic sentence when the region has no suffix list yet', () => {
      currentRegionObj.set(null);
      build('register');
      expect(hint().textContent).toContain('"suffixesText":""');
    });
  });

  it('leaves for /account once signed in, replacing the auth page in history', () => {
    build('login');
    component.email = 'me@example.com';
    component.password = 'secret';
    component.onLogin();
    isAuthenticated.set(true);
    fixture.detectChanges();

    expect(mockRouter.navigate).toHaveBeenCalledWith(['/', 'tw', 'account'], { replaceUrl: true });
  });

  it('returns to returnUrl after signing in', () => {
    TestBed.overrideProvider(ActivatedRoute, {
      useValue: { snapshot: { queryParamMap: convertToParamMap({ returnUrl: '/tw/listing/42' }) } }
    });
    build('login');
    expect(component.returnUrl).toBe('/tw/listing/42');

    component.email = 'me@example.com';
    component.password = 'secret';
    component.onLogin();
    isAuthenticated.set(true);
    fixture.detectChanges();

    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/tw/listing/42', { replaceUrl: true });
  });

  it('keeps a failed login on the page and shows the error', () => {
    mockAuth.login.mockReturnValue(throwError(() => ({ error: { error: { code: 'auth.errInvalidCredentials' } } })));
    build('login');
    component.email = 'me@example.com';
    component.password = 'wrong';
    component.onLogin();

    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(component.authIsError).toBe(true);
    expect(component.authMessage).toBe('信箱或密碼錯誤');
  });

  it('falls back rather than showing a backend code no locale declares', () => {
    // This used to assert the opposite — that the raw code reached the screen —
    // and the code it used, auth.errBadCredentials, is declared in no locale.
    // The test was holding the defect in place.
    mockAuth.login.mockReturnValue(throwError(() => ({ error: { error: { code: 'auth.errSomethingNewFromTheBackend' } } })));
    build('login');
    component.email = 'me@example.com';
    component.password = 'wrong';
    component.onLogin();

    expect(component.authIsError).toBe(true);
    expect(component.authMessage).toBe('auth.errLoginFailed');
    expect(component.authMessage).not.toContain('SomethingNew');
  });

  it('does not submit a login with empty fields', () => {
    build('login');
    component.onLogin();
    expect(mockAuth.login).not.toHaveBeenCalled();
    expect(component.authMessage).toBe('auth.errFillEmailPassword');
  });

  it('sends a successful sign-up to /login with the address prefilled, not straight in', () => {
    build('register');
    component.registerEmail = 'new@example.com';
    component.registerPassword = 'secret123';
    component.registerConfirmPassword = 'secret123';
    component.registerFirstName = 'A';
    component.registerLastName = 'B';
    component.onRegister();

    expect(mockAuth.register).toHaveBeenCalled();
    expect(mockRouter.navigate).toHaveBeenCalledWith(
      ['/', 'tw', 'login'],
      expect.objectContaining({
        state: { registeredEmail: 'new@example.com', registeredNotice: 'auth.registerSuccess' }
      })
    );
  });

  it('refuses a sign-up whose two passwords differ', () => {
    build('register');
    component.registerEmail = 'new@example.com';
    component.registerPassword = 'secret123';
    component.registerConfirmPassword = 'secret124';
    component.registerFirstName = 'A';
    component.registerLastName = 'B';
    component.onRegister();

    expect(mockAuth.register).not.toHaveBeenCalled();
    expect(component.authMessage).toBe('auth.errPasswordMismatch');
  });

  it('picks up the prefill and notice handed over by /register', () => {
    mockRouter.getCurrentNavigation.mockReturnValue({
      extras: { state: { registeredEmail: 'new@example.com', registeredNotice: 'auth.registerSuccess' } }
    });
    build('login');

    expect(component.email).toBe('new@example.com');
    expect(component.authMessage).toBe('auth.registerSuccess');
    expect(component.authIsError).toBe(false);
  });

  it('ignores that handoff on the register page itself', () => {
    mockRouter.getCurrentNavigation.mockReturnValue({
      extras: { state: { registeredEmail: 'new@example.com', registeredNotice: 'auth.registerSuccess' } }
    });
    build('register');

    expect(component.email).toBe('');
    expect(component.authMessage).toBe('');
  });
});
