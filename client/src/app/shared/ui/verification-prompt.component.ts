import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TPipe } from '../../core/i18n.service';
import { UiButton } from './button.component';
import { RegionService } from '../../core/region.service';

@Component({
  selector: 'ui-verification-prompt',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, TPipe, UiButton],
  template: `
    <div class="verification-prompt-banner" *ngIf="!isDismissed">
      <div class="prompt-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </div>
      <div class="prompt-content">
        <h4 class="prompt-title">{{ title || ('acct.unverifiedTitle' | t) }}</h4>
        <p class="prompt-desc">{{ message || ('acct.unverifiedDesc' | t:{suffix: (regionService.currentRegionObj()?.edu_email_suffix?.join(', ') || '.edu')}) }}</p>
        <div class="prompt-actions">
          <a regionLink="/account/settings" class="verify-link">
            <ui-button variant="primary">{{ 'sell.goVerify' | t }}</ui-button>
          </a>
          <button type="button" class="dismiss-btn" (click)="dismiss()">
            {{ 'common.dismiss' | t }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .verification-prompt-banner {
      display: flex;
      gap: 16px;
      padding: 16px 20px;
      background-color: var(--flag-light);
      border: 1px solid var(--flag-border);
      border-radius: 8px;
      margin-bottom: 20px;
      align-items: flex-start;
      color: var(--ink);
    }
    .prompt-icon {
      flex-shrink: 0;
      margin-top: 2px;
      color: var(--flag);
    }
    .prompt-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .prompt-title {
      margin: 0;
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--flag);
    }
    .prompt-desc {
      margin: 0;
      font-size: var(--text-base);
      line-height: 1.4;
      color: var(--ink-soft);
    }
    .prompt-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 4px;
    }
    .verify-link {
      text-decoration: none;
    }
    .dismiss-btn {
      background: none;
      border: none;
      color: var(--flag);
      font-size: var(--text-sm);
      cursor: pointer;
      text-decoration: underline;
      padding: 4px 8px;
    }
    .dismiss-btn:hover {
      opacity: 0.8;
    }
  `]
})
export class UiVerificationPrompt {
  protected regionService = inject(RegionService);

  @Input() storageKey = 'unibooks.verification_prompt.dismissed';
  @Input() title = '';
  @Input() message = '';
  @Output() onDismiss = new EventEmitter<void>();

  get isDismissed(): boolean {
    if (typeof window === 'undefined' || !window.sessionStorage) return false;
    try {
      return window.sessionStorage.getItem(this.storageKey) === 'true';
    } catch {
      return false;
    }
  }

  dismiss(): void {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.setItem(this.storageKey, 'true');
      } catch { }
    }
    this.onDismiss.emit();
  }
}
