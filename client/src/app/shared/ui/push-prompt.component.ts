import { Component, Input, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { AccountService } from '../../core/services/account.service';
import { PushService } from '../../core/services/push.service';
import { ToastService } from '../../core/services/toast.service';
import { parseApiError } from '../../core/api-error.util';
import { UiButton } from './button.component';

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
 */
@Component({
  selector: 'ui-push-prompt',
  standalone: true,
  imports: [TPipe, UiButton],
  // Pages give the element its spacing (a margin around the inbox list, under
  // the sell form's title); with nothing to ask, the element must take no room
  // at all, or that margin stays behind as a blank strip.
  host: { '[style.display]': "visible() ? null : 'none'" },
  template: `
    @if (visible()) {
      <div
        class="push-prompt"
        role="region"
        [attr.aria-label]="'pushPrompt.title' | t"
        data-testid="push-prompt"
      >
        <svg
          class="push-prompt-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          width="20"
          height="20"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <div class="push-prompt-content">
          <p class="push-prompt-title">{{ 'pushPrompt.title' | t }}</p>
          <p class="push-prompt-desc">
            {{ (context === 'sell' ? 'pushPrompt.descSell' : 'pushPrompt.descMessages') | t }}
          </p>
          <div class="push-prompt-actions">
            <ui-button size="sm" [disabled]="busy()" (onClick)="enable()">{{
              (busy() ? 'pushPrompt.enabling' : 'pushPrompt.enable') | t
            }}</ui-button>
            <ui-button size="sm" variant="ghost" [disabled]="busy()" (onClick)="dismiss()">{{
              'pushPrompt.later' | t
            }}</ui-button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .push-prompt {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
        padding: var(--space-4);
        background-color: var(--surface-card);
        border: 1px solid var(--line);
        border-radius: var(--radius-card);
        color: var(--ink);
        text-align: left;
      }
      .push-prompt-icon {
        flex: none;
        margin-top: 2px;
        color: var(--info-ink);
      }
      .push-prompt-content {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .push-prompt-title {
        margin: 0;
        font-weight: 600;
      }
      .push-prompt-desc {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.4;
        color: var(--ink-soft);
      }
      .push-prompt-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
    `,
  ],
})
export class UiPushPrompt {
  private push = inject(PushService);
  private authStore = inject(AuthStore);
  private accountService = inject(AccountService);
  private toast = inject(ToastService);
  private i18n = inject(I18nService);

  /** Which page it sits on; only the wording changes. */
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
