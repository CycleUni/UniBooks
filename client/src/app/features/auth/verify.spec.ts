import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { VerifyEmail } from './verify';
import { AuthStore } from '../../core/auth.store';
import { I18nService } from '../../core/i18n.service';
import { RegionLinkService } from '../../core/region-link.service';

describe('VerifyEmail (account activation)', () => {
  let auth: { verifyRegistration: ReturnType<typeof vi.fn>; verifyEmail: ReturnType<typeof vi.fn> };
  let params: BehaviorSubject<Record<string, string>>;

  const create = () => {
    const fixture = TestBed.createComponent(VerifyEmail);
    fixture.componentInstance.ngOnInit();
    return fixture.componentInstance;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    params = new BehaviorSubject<Record<string, string>>({ token: 'mail-token', type: 'register' });
    auth = { verifyRegistration: vi.fn(() => of({})), verifyEmail: vi.fn(() => of({})) };
    TestBed.configureTestingModule({
      imports: [VerifyEmail],
      providers: [
        { provide: AuthStore, useValue: auth },
        {
          provide: ActivatedRoute,
          useValue: { queryParams: params, snapshot: { queryParams: {} } },
        },
        { provide: Router, useValue: { navigate: vi.fn().mockResolvedValue(true) } },
        { provide: RegionLinkService, useValue: { path: (p: string[]) => p } },
        { provide: I18nService, useValue: { t: (k: string) => k, tOrNull: (k: string) => k } },
      ],
    }).overrideComponent(VerifyEmail, { set: { template: '' } });
  });

  afterEach(() => vi.useRealTimers());

  it('waits for the registration password instead of activating on load', () => {
    const c = create();
    expect(auth.verifyRegistration).not.toHaveBeenCalled();
    expect(c.tokenFromLink).toBe(true);
    expect(c.canSubmit).toBe(false);

    c.password = 'Correct-Pass-123!';
    c.submitVerify();
    expect(auth.verifyRegistration).toHaveBeenCalledWith('mail-token', 'Correct-Pass-123!');
    expect(c.status).toBe('success');
  });

  it('keeps the form, with an inline error, when the password does not match the link', () => {
    auth.verifyRegistration.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { error: { code: 'auth.errActivationPasswordMismatch' } },
          }),
      ),
    );
    const c = create();
    c.password = 'wrong';
    c.submitVerify();
    expect(c.status).toBe('idle');
    expect(c.passwordError).toBe('auth.errActivationPasswordMismatch');
    expect(c.inputToken).toBe('mail-token');
  });

  it('still sends a campus-email link right away', () => {
    params.next({ token: 'edu-token' });
    create();
    expect(auth.verifyEmail).toHaveBeenCalledWith('edu-token');
  });

  it('moves on once: tapping the button cancels the automatic move', () => {
    params.next({});
    const c = TestBed.createComponent(VerifyEmail).componentInstance;
    c.inputToken = 'edu-token';
    c.submitVerify();
    const navigate = TestBed.inject(Router).navigate as ReturnType<typeof vi.fn>;
    navigate.mockClear();
    // The success screen's button, before the 3 seconds are up.
    c.goNext();
    vi.advanceTimersByTime(5000);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('does not move on by itself after the page is left', () => {
    params.next({});
    const fixture = TestBed.createComponent(VerifyEmail);
    const c = fixture.componentInstance;
    c.inputToken = 'edu-token';
    c.submitVerify();
    const navigate = TestBed.inject(Router).navigate as ReturnType<typeof vi.fn>;
    navigate.mockClear();
    fixture.destroy();
    vi.advanceTimersByTime(5000);
    expect(navigate).not.toHaveBeenCalled();
  });
});
