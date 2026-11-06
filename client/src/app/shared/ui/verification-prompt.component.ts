import { Component, Input, Output, EventEmitter, booleanAttribute, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TPipe } from '../../core/i18n.service';
import { RegionService } from '../../core/region.service';
import { AuthStore } from '../../core/auth.store';
import { UiFloatingPrompt } from './floating-prompt.component';

/**
 * Tells a member whose school email is not verified yet that listing and
 * messaging need it, as a floating card (ui-floating-prompt) in the same style
 * as the language and push offers; the three share one slot, so they queue.
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
        [title]="title || ('acct.unverifiedTitle' | t)"
        [description]="
          message ||
          ('acct.unverifiedDesc'
            | t
              : {
                  suffix: regionService.currentRegionObj()?.edu_email_suffix?.join(', ') || '.edu',
                })
        "
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

  @Input() storageKey = 'unibooks.verification_prompt.dismissed';
  /**
   * Shown because the visitor just tried something that needs verification
   * (contact a seller, list a book): then an earlier dismissal does not hide
   * it, or the tap would seem to do nothing at all. The dismissal only quiets
   * the card a page shows on arrival.
   */
  @Input() requested = false;
  /**
   * The card decides for itself: only for a signed-in member (profile loaded)
   * without a verified school email in this region. Without it the owner
   * decides by rendering it or not.
   */
  @Input({ transform: booleanAttribute }) whenUnverified = false;
  @Input() title = '';
  @Input() message = '';
  @Output() onDismiss = new EventEmitter<void>();

  get shouldShow(): boolean {
    if (!this.whenUnverified || this.requested) return true;
    return !!this.authStore.user() && !this.authStore.isVerifiedIn(this.regionService.region());
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
    void this.router.navigate(['/', this.regionService.region(), 'account', 'settings']);
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
