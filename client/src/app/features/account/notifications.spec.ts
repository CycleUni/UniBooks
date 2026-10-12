import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';

import { NotificationsComponent } from './notifications';
import { AccountService } from '../../core/services/account.service';
import { ToastService } from '../../core/services/toast.service';
import { I18nService } from '../../core/i18n.service';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { AuthStore } from '../../core/auth.store';
import { PushService } from '../../core/services/push.service';

describe('NotificationsComponent', () => {
  let fixture: ComponentFixture<NotificationsComponent>;
  let account: { getNotificationSettings: ReturnType<typeof vi.fn>; updateNotificationSettings: ReturnType<typeof vi.fn> };
  let push: {
    availability: ReturnType<typeof vi.fn>;
    isEnabledHere: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
  };
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  const el = () => fixture.nativeElement as HTMLElement;
  const toggle = () => el().querySelector('input[role="switch"]') as HTMLInputElement | null;
  const click = () => {
    const input = toggle()!;
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };

  function create() {
    fixture = TestBed.createComponent(NotificationsComponent);
    fixture.detectChanges();
  }

  beforeEach(() => {
    account = {
      getNotificationSettings: vi.fn(() => of({ new_message_email: true, push: true, email_language: 'auto', site_language: 'zh-TW' })),
      updateNotificationSettings: vi.fn((changes: any) => of({ new_message_email: true, push: true, email_language: 'auto', site_language: 'zh-TW', ...changes })),
    };
    // Push is off the page unless a test turns it on.
    push = {
      availability: vi.fn(() => Promise.resolve('unavailable')),
      isEnabledHere: vi.fn(() => false),
      enable: vi.fn(() => Promise.resolve('enabled')),
      disable: vi.fn(() => Promise.resolve()),
    };
    toast = { success: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      imports: [NotificationsComponent],
      providers: [
        { provide: AccountService, useValue: account },
        { provide: ToastService, useValue: toast },
        { provide: PushService, useValue: push },
        { provide: AuthStore, useValue: { user: signal({ id: 7 }) } },
        {
          provide: I18nService,
          useValue: {
            t: (k: string, params?: Record<string, string>) => (params ? `${k}|${JSON.stringify(params)}` : k),
            tOrNull: () => null,
            lang: signal('zh-TW'),
          },
        },
      ],
    });
  });

  it('shows the new-message email switch in its saved position, as an accessible switch', () => {
    create();

    const input = toggle()!;
    expect(input).not.toBeNull();
    expect(input.checked).toBe(true);
    expect(input.getAttribute('aria-checked')).toBe('true');
    expect(el().querySelector('#' + input.getAttribute('aria-labelledby'))?.textContent).toContain('acct.notifyNewMessageEmail');
  });

  it('saves the switch when it is turned off', () => {
    create();

    click();

    expect(account.updateNotificationSettings).toHaveBeenCalledWith({ new_message_email: false });
    expect(toggle()!.checked).toBe(false);
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    expect(toast.success).toHaveBeenCalledWith('acct.notifySaved');
  });

  it('puts the switch back and says so when saving fails', () => {
    account.updateNotificationSettings.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
    create();

    click();

    expect(toggle()!.checked).toBe(true);
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    expect(toast.error).toHaveBeenCalledWith('acct.notifySaveFailed');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('holds the switch still while a save is in progress', () => {
    const pending = new Subject<any>();
    account.updateNotificationSettings.mockReturnValue(pending);
    create();

    click();
    expect(toggle()!.disabled).toBe(true);
    expect(toggle()!.closest('label')!.classList.contains('is-busy')).toBe(true);

    pending.next({ new_message_email: false });
    pending.complete();
    fixture.detectChanges();
    expect(toggle()!.disabled).toBe(false);
    expect(toggle()!.closest('label')!.classList.contains('is-busy')).toBe(false);
  });

  it('offers a retry when the settings cannot be loaded', () => {
    account.getNotificationSettings.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 503 })));
    create();

    expect(toggle()).toBeNull();
    const retry = el().querySelector('ui-error-state button') as HTMLButtonElement;
    expect(retry).not.toBeNull();

    retry.click();
    fixture.detectChanges();

    expect(account.getNotificationSettings).toHaveBeenCalledTimes(2);
    expect(toggle()!.checked).toBe(true);
  });

  describe('email language', () => {
    const dropdown = () => fixture.debugElement.query(By.directive(UiDropdown)).componentInstance as UiDropdown;
    const pick = (value: string) => {
      dropdown().selectOption({ value, label: value });
      fixture.detectChanges();
    };

    it('offers following the site, naming the language that means right now, and each language', async () => {
      create();
      // ngModel hands the initial value to the control a microtask later.
      await fixture.whenStable();

      const options = dropdown().options;
      expect(options.map(o => o.value)).toEqual(['auto', 'zh-TW', 'zh-HK', 'en']);
      expect(options[0].label).toBe('acct.emailLanguageAuto|{"lang":"中文 (繁體)"}');
      expect(dropdown().value).toBe('auto');
    });

    it('saves a chosen language', () => {
      create();

      pick('en');

      expect(account.updateNotificationSettings).toHaveBeenCalledWith({ email_language: 'en' });
      expect(dropdown().value).toBe('en');
      expect(toast.success).toHaveBeenCalledWith('acct.notifySaved');
    });

    it('puts the choice back and says so when saving fails', () => {
      account.updateNotificationSettings.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
      create();

      pick('en');

      expect(dropdown().value).toBe('auto');
      expect(toast.error).toHaveBeenCalledWith('acct.notifySaveFailed');
    });
  });

  it('keeps the settings on screen when a refresh fails, and says so', () => {
    create();
    account.getNotificationSettings.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 503 })));

    fixture.componentInstance.onRefresh();
    fixture.detectChanges();

    expect(toggle()).not.toBeNull();
    expect(el().querySelector('ui-error-state')).toBeNull();
    expect(el().querySelector('ui-skeleton')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('acct.notifyLoadFailed');
  });

  it('re-fetches settings on onRefresh', () => {
    create();
    expect(account.getNotificationSettings).toHaveBeenCalledTimes(1);

    fixture.componentInstance.onRefresh();

    expect(account.getNotificationSettings).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.refreshing).toBe(false);
  });

  describe('push notifications', () => {
    const pushToggle = () => el().querySelector('input[data-testid="push-switch"]') as HTMLInputElement | null;
    const flip = async () => {
      const input = pushToggle()!;
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const createWith = async (availability: string, enabledHere = false) => {
      push.availability.mockResolvedValue(availability);
      push.isEnabledHere.mockReturnValue(enabledHere);
      create();
      await fixture.whenStable();
      fixture.detectChanges();
    };

    it('shows no push row when push is unavailable here', async () => {
      await createWith('unavailable');
      expect(pushToggle()).toBeNull();
    });

    it('shows the switch on only when the account setting and this browser are both on', async () => {
      await createWith('ready', true);
      expect(pushToggle()!.checked).toBe(true);
    });

    it('shows the switch off when this browser has not been set up, whatever the account says', async () => {
      await createWith('ready', false);
      expect(pushToggle()!.checked).toBe(false);
    });

    it('asks the browser first, and saves the account setting once it can receive', async () => {
      await createWith('ready', false);
      push.isEnabledHere.mockReturnValue(true);

      await flip();

      expect(push.enable).toHaveBeenCalledWith(7);
      expect(account.updateNotificationSettings).toHaveBeenCalledWith({ push: true });
      expect(pushToggle()!.checked).toBe(true);
      expect(toast.success).toHaveBeenCalledWith('acct.notifySaved');
    });

    it('shows the push switch working, not greyed out, while the permission prompt is open', async () => {
      await createWith('ready', false);
      let answer!: (result: string) => void;
      push.enable.mockReturnValue(new Promise((resolve) => (answer = resolve)));

      const input = pushToggle()!;
      input.checked = true;
      input.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      const label = input.closest('label')!;
      expect(label.classList.contains('is-busy')).toBe(true);
      expect(input.getAttribute('aria-busy')).toBe('true');
      expect(input.disabled).toBe(true);
      // The other switch is held still but not marked as the one working.
      expect(toggle()!.closest('label')!.classList.contains('is-busy')).toBe(false);

      answer('failed');
      await fixture.whenStable();
      fixture.detectChanges();
      expect(label.classList.contains('is-busy')).toBe(false);
      expect(input.getAttribute('aria-busy')).toBe('false');
    });

    it('does not mark a switch that is disabled for good as working', async () => {
      await createWith('blocked');
      const input = pushToggle()!;
      expect(input.disabled).toBe(true);
      expect(input.closest('label')!.classList.contains('is-busy')).toBe(false);
    });

    it('leaves it off and says so when the permission prompt is refused', async () => {
      await createWith('ready', false);
      push.enable.mockResolvedValue('denied');
      push.availability.mockResolvedValue('blocked');

      await flip();

      expect(account.updateNotificationSettings).not.toHaveBeenCalled();
      expect(pushToggle()!.checked).toBe(false);
      expect(toast.error).toHaveBeenCalledWith('acct.notifyPushDenied');
      expect(el().textContent).toContain('acct.notifyPushBlocked');
    });

    it('leaves it off and says so when the browser cannot be set up', async () => {
      await createWith('ready', false);
      push.enable.mockResolvedValue('failed');

      await flip();

      expect(account.updateNotificationSettings).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('acct.notifyPushFailed');
    });

    it('takes the browser back out when the account setting cannot be saved', async () => {
      await createWith('ready', false);
      account.updateNotificationSettings.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));

      await flip();

      expect(push.disable).toHaveBeenCalled();
      expect(pushToggle()!.checked).toBe(false);
      expect(toast.error).toHaveBeenCalledWith('acct.notifySaveFailed');
    });

    it('turning it off saves the setting and removes this browser', async () => {
      await createWith('ready', true);
      push.isEnabledHere.mockReturnValue(false);

      await flip();

      expect(account.updateNotificationSettings).toHaveBeenCalledWith({ push: false });
      expect(push.disable).toHaveBeenCalled();
      expect(pushToggle()!.checked).toBe(false);
    });

    it.each(['blocked', 'needs-install'])('disables the switch and explains why when %s', async (availability) => {
      await createWith(availability);
      expect(pushToggle()!.disabled).toBe(true);
      expect(el().querySelector('[role="note"]')).not.toBeNull();
    });
  });
});
