import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../../core/auth.store';
import { I18nService, TPipe } from '../../core/i18n.service';
import { RegionLinkService } from '../../core/region-link.service';
import { clearSensitiveParams } from '../../core/sensitive-url';


@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, UiButton, UiInput, TPipe],
  template: `
      <div class="fp-container">
        <div class="fp-box">
          <!-- No token in the URL: request a reset link -->
          <ng-container *ngIf="!token">
            <ng-container *ngIf="requestStatus !== 'sent'">
              <h2>{{ 'fp.requestTitle' | t }}</h2>
              <p>{{ 'fp.requestHint' | t }}</p>

              <div  style="margin: 24px 0; text-align: left;">
                <ui-input type="email" autocomplete="email" [placeholder]="'auth.emailLabel' | t" [(ngModel)]="email" [disabled]="requestStatus === 'loading'"></ui-input>
              </div>

              <div *ngIf="errorMessage" class="error-msg">{{ errorMessage }}</div>

              <ui-button  block (onClick)="submitRequest()" [disabled]="!email || requestStatus === 'loading'">
                {{ (requestStatus === 'loading' ? 'fp.sending' : 'fp.sendLink') | t }}
              </ui-button>
            </ng-container>

            <ng-container *ngIf="requestStatus === 'sent'">
              <h2>{{ 'fp.sentTitle' | t }}</h2>
              <p>{{ 'fp.sentBody' | t }}</p>
              <ui-button  class="mt-5" variant="ghost" (onClick)="goToLogin()">{{ 'auth.backToLogin' | t }}</ui-button>
            </ng-container>
          </ng-container>

          <!-- Token present: set a new password -->
          <ng-container *ngIf="token">
            <ng-container *ngIf="confirmStatus !== 'success'">
              <h2>{{ 'fp.confirmTitle' | t }}</h2>
              <p>{{ 'fp.confirmHint' | t }}</p>

              <div  style="margin: 24px 0; text-align: left; display: flex; flex-direction: column; gap: 12px;">
                <ui-input type="password" [placeholder]="'acct.newPassword' | t" [(ngModel)]="newPassword" [disabled]="confirmStatus === 'loading'"></ui-input>
                <ui-input type="password" [placeholder]="'acct.confirmNewPassword' | t" [(ngModel)]="confirmPassword" [disabled]="confirmStatus === 'loading'"></ui-input>
              </div>

              <div *ngIf="errorMessage" class="error-msg">{{ errorMessage }}</div>

              <ui-button  block (onClick)="submitConfirm()" [disabled]="!newPassword || confirmStatus === 'loading'">
                {{ (confirmStatus === 'loading' ? 'fp.saving' : 'fp.setNewPassword') | t }}
              </ui-button>
            </ng-container>

            <ng-container *ngIf="confirmStatus === 'success'">
              <h2>{{ 'fp.successTitle' | t }}</h2>
              <p>{{ 'fp.successBody' | t }}</p>
              <ui-button  class="mt-5" (onClick)="goToLogin()">{{ 'verify.goToLogin' | t }}</ui-button>
            </ng-container>
          </ng-container>
        </div>
      </div>
  `,
  styles: [`
    .fp-container {
      display: flex;
      justify-content: center;
      padding: 80px 16px;
    }
    .fp-box {
      width: 100%;
      max-width: 480px;
      padding: 48px 32px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background-color: var(--surface-card);
      text-align: center;
    }
    .fp-box h2 {
      margin-top: 0;
      margin-bottom: 16px;
      font-size: var(--text-2xl);
    }
    .fp-box p {
      color: var(--muted);
      line-height: 1.6;
      margin: 0;
    }
    .error-msg {
      color: var(--flag);
      font-weight: 500;
      font-size: var(--text-base);
      margin: 12px 0;
    }
  `]
})
export class ForgotPassword implements OnInit {
  token = '';
  email = '';
  newPassword = '';
  confirmPassword = '';
  errorMessage = '';

  requestStatus: 'idle' | 'loading' | 'sent' = 'idle';
  confirmStatus: 'idle' | 'loading' | 'success' = 'idle';

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private auth = inject(AuthStore);
  private cdr = inject(ChangeDetectorRef);
  readonly i18n = inject(I18nService);

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      // Kept once read: the address bar loses it right after (see
      // clearSensitiveParams), which fires this again without it.
      if (params['token']) {
        this.token = params['token'];
        clearSensitiveParams(this.router, this.route);
      }
      this.cdr.markForCheck();
    });
  }

  submitRequest() {
    if (!this.email) return;
    this.requestStatus = 'loading';
    this.errorMessage = '';
    this.cdr.markForCheck();

    this.auth.requestPasswordReset(this.email).subscribe({
      // Always the same success state regardless of whether the email
      // exists — the backend deliberately doesn't reveal that either.
      next: () => {
        this.requestStatus = 'sent';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.requestStatus = 'idle';
        const code = err.error?.error?.code;
        this.errorMessage = code ? this.i18n.t(code) : this.i18n.t('verify.errUnknown');
        this.cdr.markForCheck();
      }
    });
  }

  submitConfirm() {
    if (!this.newPassword) return;
    if (this.newPassword !== this.confirmPassword) {
      this.errorMessage = this.i18n.t('auth.errPasswordMismatch');
      this.cdr.markForCheck();
      return;
    }

    this.confirmStatus = 'loading';
    this.errorMessage = '';
    this.cdr.markForCheck();

    this.auth.confirmPasswordReset(this.token, this.newPassword).subscribe({
      next: () => {
        this.confirmStatus = 'success';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.confirmStatus = 'idle';
        const code = err.error?.error?.code;
        const fieldErrors: string[] | undefined = err.error?.error?.fields;
        this.errorMessage = fieldErrors?.length
          ? fieldErrors.join(' ')
          : (code ? this.i18n.t(code) : this.i18n.t('verify.errUnknown'));
        this.cdr.markForCheck();
      }
    });
  }

  goToLogin() {
    this.router.navigate(this.regionLink.path(['/login']));
  }
}
