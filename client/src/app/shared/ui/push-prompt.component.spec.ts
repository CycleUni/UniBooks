import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';

import { UiPushPrompt } from './push-prompt.component';
import { AccountService } from '../../core/services/account.service';
import { ToastService } from '../../core/services/toast.service';
import { I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { PushService } from '../../core/services/push.service';

describe('UiPushPrompt', () => {
  let fixture: ComponentFixture<UiPushPrompt>;
  let account: {
    getNotificationSettings: ReturnType<typeof vi.fn>;
    updateNotificationSettings: ReturnType<typeof vi.fn>;
  };
  let push: {
    availability: ReturnType<typeof vi.fn>;
    isEnabledHere: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
  };
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let user: ReturnType<typeof signal<{ id: number } | null>>;

  const prompt = () =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-testid="push-prompt"]');
  const buttons = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));

  async function create() {
    fixture = TestBed.createComponent(UiPushPrompt);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    account = {
      getNotificationSettings: vi.fn(() =>
        of({ new_message_email: true, push: true, email_language: 'auto', site_language: 'zh-TW' }),
      ),
      updateNotificationSettings: vi.fn((changes: any) =>
        of({
          new_message_email: true,
          push: true,
          email_language: 'auto',
          site_language: 'zh-TW',
          ...changes,
        }),
      ),
    };
    push = {
      availability: vi.fn(() => Promise.resolve('ready')),
      isEnabledHere: vi.fn(() => false),
      enable: vi.fn(() => Promise.resolve('enabled')),
      disable: vi.fn(() => Promise.resolve()),
    };
    toast = { success: vi.fn(), error: vi.fn() };
    user = signal<{ id: number } | null>({ id: 7 });
    TestBed.configureTestingModule({
      imports: [UiPushPrompt],
      providers: [
        { provide: AccountService, useValue: account },
        { provide: ToastService, useValue: toast },
        { provide: PushService, useValue: push },
        { provide: AuthStore, useValue: { user } },
        {
          provide: I18nService,
          useValue: { t: (k: string) => k, tOrNull: () => null, lang: signal('zh-TW') },
        },
      ],
    });
  });

  it('asks when this browser has no push set up', async () => {
    await create();
    expect(prompt()).not.toBeNull();
  });

  it('stays hidden when push already works here', async () => {
    push.isEnabledHere.mockReturnValue(true);
    await create();
    expect(prompt()).toBeNull();
  });

  it('asks when this browser is registered but the account switch was turned off', async () => {
    push.isEnabledHere.mockReturnValue(true);
    account.getNotificationSettings.mockReturnValue(
      of({ new_message_email: true, push: false, email_language: 'auto', site_language: 'zh-TW' }),
    );
    await create();
    expect(prompt()).not.toBeNull();
  });

  it('stays hidden where the switch could not work (blocked, iPhone outside the Home Screen)', async () => {
    push.availability.mockResolvedValue('blocked');
    await create();
    expect(prompt()).toBeNull();
  });

  it('waits for the profile before checking', async () => {
    user.set(null);
    await create();
    expect(push.availability).not.toHaveBeenCalled();
    user.set({ id: 7 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(prompt()).not.toBeNull();
  });

  it('turns push on in the browser, then on the account', async () => {
    await create();
    buttons()[0].click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(push.enable).toHaveBeenCalledWith(7);
    expect(account.updateNotificationSettings).toHaveBeenCalledWith({ push: true });
    expect(toast.success).toHaveBeenCalledWith('pushPrompt.enabled');
    expect(prompt()).toBeNull();
  });

  it('takes the browser back out when the account setting fails to save', async () => {
    account.updateNotificationSettings.mockReturnValue(throwError(() => new Error('boom')));
    await create();
    buttons()[0].click();
    await fixture.whenStable();
    expect(push.disable).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('"Not now" hides it here and on the next page', async () => {
    await create();
    buttons()[1].click();
    fixture.detectChanges();
    expect(prompt()).toBeNull();

    fixture.destroy();
    await create();
    expect(push.availability).toHaveBeenCalledTimes(1);
    expect(prompt()).toBeNull();
  });
});
