import { Component, Input, Output, EventEmitter, booleanAttribute, inject } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService, TPipe } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';
import { UiFloatingPrompt } from './floating-prompt.component';

/**
 * Tells a member whose school requires campus verification that trading
 * needs it, as a floating card (ui-floating-prompt).
 */
@Component({
  selector: 'ui-verification-prompt',
  standalone: true,
  imports: [TPipe, UiFloatingPrompt],
  template: `
    @if (shouldShow && (requested || !isDismissed)) {
      <ui-floating-prompt
        icon="mail"
        testId="verification-prompt"
        [priority]="2"
        [title]="promptTitle"
        [description]="promptMessage"
        [acceptLabel]="'verifyPrompt.go' | t"
        [dismissLabel]="'verifyPrompt.later' | t"
        (accept)="goVerify()"
        (dismiss)="dismiss()"
      ></ui-floating-prompt>
    }
  `,
})
export class UiVerificationPrompt {
  protected regionService = inject(RegionService);
  private router = inject(Router);
  private authStore = inject(AuthStore);
  private i18n = inject(I18nService);

  @Input() storageKey = 'unibooks.verification_prompt.dismissed';
  /**
   * Shown because the visitor just tried something that needs verification
   * (contact a seller, list a book): then an earlier dismissal does not hide
   * it, or the tap would seem to do nothing at all. The dismissal only quiets
   * the card a page shows on arrival.
   */
  @Input() requested = false;
  /**
   * The card decides for itself: only for a signed-in member whose school
   * requires verification and who does not hold a live verification in this region.
   * Without it the owner decides by rendering it or not.
   */
  @Input({ transform: booleanAttribute }) whenUnverified = false;
  @Input() title = '';
  @Input() message = '';
  @Output() onDismiss = new EventEmitter<void>();

  get shouldShow(): boolean {
    if (!this.whenUnverified || this.requested) return true;
    const user = this.authStore.user();
    if (!user) return false;
    const region = this.regionService.region();
    return this.authStore.mustVerifyIn(region) && !this.authStore.isVerifiedIn(region);
  }

  get promptTitle(): string {
    return this.title || this.i18n.t('acct.unverifiedTitle');
  }

  get promptMessage(): string {
    if (this.message) return this.message;
    const region = this.regionService.region();
    const school = this.authStore.schoolForRegion(region);
    if (school) {
      return this.i18n.t('acct.errVerificationRequiredForSchool', { school, region });
    }
    return this.i18n.t('acct.unverifiedDesc', {
      suffix: this.regionService.currentRegionObj()?.edu_email_suffix?.join(', ') || '.edu',
    });
  }

  get isDismissed(): boolean {
    if (typeof window === 'undefined' || !window.sessionStorage) return false;
    try {
      return window.sessionStorage.getItem(this.storageKey) === 'true';
    } catch {
      return false;
    }
  }

  goVerify(): void {
    const currentUrl = this.router.url;
    void this.router.navigate(['/', this.regionService.region(), 'account', 'verification'], {
      queryParams: currentUrl ? { returnUrl: currentUrl } : undefined,
    });
  }

  dismiss(): void {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.setItem(this.storageKey, 'true');
      } catch {}
    }
    this.onDismiss.emit();
  }
}
