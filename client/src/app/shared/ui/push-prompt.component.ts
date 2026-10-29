import { Component, Input, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { PushService } from '../../core/services/push.service';
import { ToastService } from '../../core/services/toast.service';
import { parseApiError } from '../../core/api-error.util';
import { UiFloatingPrompt } from './floating-prompt.component';

const DISMISSED_KEY = 'unibooks.push-prompt.dismissed-at';
/** "Not now" quiets the prompt on every page for this long, then it may ask again. */
const QUIET_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Asks a member who has not turned push on in this browser whether to, on the
 * pages where a missed message costs them most: listing a book (buyers will
 * write) and the inbox.
 *
 * Shown only when the switch on the Notifications page would work here
 * (`ready`): a blocked permission or an iPhone outside the Home Screen cannot
 * be fixed from a button, and that page already explains both. Turning it on
 * does what that switch does — browser permission and token first, then the
 * account setting — so the two never disagree.
 *
 * It floats over the page (ui-floating-prompt), as the language offer does,
 * so where a page puts it does not matter and it never takes the page's room.
 */
@Component({
  selector: 'ui-push-prompt',
  standalone: true,
  imports: [TPipe, UiFloatingPrompt],
  template: `
    @if (visible()) {
      <ui-floating-prompt
        icon="bell"
        testId="push-prompt"
        [title]="'pushPrompt.title' | t"
        [description]="(context === 'sell' ? 'pushPrompt.descSell' : 'pushPrompt.descMessages') | t"
        [acceptLabel]="(busy() ? 'pushPrompt.enabling' : 'pushPrompt.enable') | t"
        [dismissLabel]="'pushPrompt.later' | t"
        [busy]="busy()"
        (accept)="enable()"
        (dismiss)="dismiss()"
      ></ui-floating-prompt>
    }
  `,
})
export class UiPushPrompt {
  private push = inject(PushService);
  private authStore = inject(AuthStore);
  private accountService = inject(AccountService);
  private toast = inject(ToastService);
  private i18n = inject(I18nService);

  /** Which page asks; only the wording changes. */
  @Input() context: 'sell' | 'messages' = 'messages';

  readonly visible = signal(false);
  readonly busy = signal(false);

  constructor() {
    // The profile may still be loading when the page opens; check once it is in.
    let checked = false;
    effect(() => {
      const userId = this.authStore.user()?.id;
      if (checked || userId === undefined) return;
      checked = true;
      untracked(() => void this.check(userId));
    });
  }

  private async check(userId: string | number) {
    if (this.recentlyDismissed()) return;
    if ((await this.push.availability()) !== 'ready') return;
    // Registered here, but the account switch may since have been turned off
    // on another device; only the settings say which.
    if (this.push.isEnabledHere(userId)) {
      try {
        if ((await firstValueFrom(this.accountService.getNotificationSettings())).push) return;
      } catch {
        return; // Not worth asking on a guess.
      }
    }
    this.visible.set(true);
  }

  async enable() {
    const userId = this.authStore.user()?.id;
    if (userId === undefined || this.busy()) return;
    this.busy.set(true);
    const result = await this.push.enable(userId);
    if (result !== 'enabled') {
      this.busy.set(false);
      if (result === 'denied') {
        // The browser will not ask again; the Notifications page explains how to undo it.
        this.visible.set(false);
        this.toast.error(this.i18n.t('acct.notifyPushDenied'));
      } else {
        this.toast.error(this.i18n.t('acct.notifyPushFailed'));
      }
      return;
    }
    try {
      await firstValueFrom(this.accountService.updateNotificationSettings({ push: true }));
      this.visible.set(false);
      this.toast.success(this.i18n.t('pushPrompt.enabled'));
    } catch (err) {
      // Same as the Notifications switch: never leave the browser registered
      // for an account setting the server does not have.
      await this.push.disable();
      this.toast.error(parseApiError(err, this.i18n, 'acct.notifySaveFailed'));
    } finally {
      this.busy.set(false);
    }
  }

  dismiss() {
    this.visible.set(false);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // It only asks again on the next visit.
    }
  }

  private recentlyDismissed(): boolean {
    try {
      const at = Number(localStorage.getItem(DISMISSED_KEY));
      return at > 0 && Date.now() - at < QUIET_FOR_MS;
    } catch {
      return false;
    }
  }
}
