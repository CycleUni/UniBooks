import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { ChangeDetectorRef } from '@angular/core';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiSuccessCheck } from '../../shared/ui/success-check.component';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../../core/auth.store';
import { I18nService, TPipe } from '../../core/i18n.service';
import { RegionLinkService } from '../../core/region-link.service';
import { clearSensitiveParams } from '../../core/sensitive-url';


@Component({
  selector: 'app-verify',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, UiButton, UiInput, UiSuccessCheck, TPipe],
  template: `
      <div class="verify-container">
        <div class="verify-box">
          <ng-container *ngIf="status === 'idle' || status === 'loading'">
            <h2>{{ (type === 'register' ? 'verify.activateTitle' : 'verify.title') | t }}</h2>
            <p>{{ (type === 'register' ? 'verify.activateHint' : 'verify.hint') | t }}</p>

            <div class="verify-fields">
              <ui-input *ngIf="!tokenFromLink" [placeholder]="'verify.tokenPlaceholder' | t" [(ngModel)]="inputToken" [disabled]="status === 'loading'"></ui-input>
              <ng-container *ngIf="type === 'register'">
                <label for="activate-password">{{ 'auth.passwordLabel' | t }}</label>
                <ui-input inputId="activate-password" type="password" name="password" autocomplete="current-password"
                  [ariaDescribedby]="passwordError ? 'activate-password-error' : ''"
                  [placeholder]="'auth.passwordPlaceholder' | t" [(ngModel)]="password"
                  [disabled]="status === 'loading'" (keyup.enter)="submitVerify()"></ui-input>
                <p *ngIf="passwordError" id="activate-password-error" class="error-msg field-error" role="alert">{{ passwordError }}</p>
              </ng-container>
            </div>

            <ui-button  block (onClick)="submitVerify()" [disabled]="!canSubmit || status === 'loading'">
              {{ (status === 'loading' ? 'verify.verifying' : (type === 'register' ? 'verify.activateSubmit' : 'verify.submit')) | t }}
            </ui-button>
          </ng-container>

          <ng-container *ngIf="status === 'success'">
            <div class="success-icon"><ui-success-check></ui-success-check></div>
            <h2>{{ 'verify.successTitle' | t }}</h2>
            <p>{{ (type === 'register' ? 'verify.successBodyRegister' : 'verify.successBodyEdu') | t }}</p>
            <p  class="mt-4" style="font-size: var(--text-base);">{{ 'verify.redirecting' | t }}</p>
            <ui-button  class="mt-5" (onClick)="goNext()">{{ (type === 'register' ? 'verify.goHome' : 'verify.goToLogin') | t }}</ui-button>
          </ng-container>

          <ng-container *ngIf="status === 'error'">
            <h2>{{ 'verify.errorTitle' | t }}</h2>
            <p class="error-msg">{{ errorMessage }}</p>
            <p>{{ 'verify.errorHint' | t }}</p>
            <ui-button  class="mt-5" variant="ghost" (onClick)="reset()">{{ 'verify.retry' | t }}</ui-button>
          </ng-container>
        </div>
      </div>
  `,
  styles: [`
    .verify-container {
      display: flex;
      justify-content: center;
      padding: 80px 16px;
    }
    .verify-box {
      width: 100%;
      max-width: 480px;
      padding: 48px 32px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background-color: var(--surface-card);
      text-align: center;
    }
    .verify-box h2 {
      margin-top: 0;
      margin-bottom: 16px;
      font-size: var(--text-2xl);
    }
    .verify-box p {
      color: var(--muted);
      line-height: 1.6;
      margin: 0;
    }
    .verify-fields {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 24px 0;
      text-align: left;
    }
    .verify-fields label {
      font-size: var(--text-sm);
      color: var(--ink);
    }
    .field-error {
      margin: 0 !important;
      font-size: var(--text-sm);
    }
    .success-icon {
      margin-bottom: 16px;
    }
    .error-msg {
      color: var(--flag) !important;
      font-weight: 500;
      margin-bottom: 8px !important;
    }
  `]
})
export class VerifyEmail implements OnInit {
  status: 'idle' | 'loading' | 'success' | 'error' = 'idle';
  errorMessage = '';
  inputToken = '';
  /** The token arrived in the link, so the visitor is not asked to paste it. */
  tokenFromLink = false;
  password = '';
  passwordError = '';
  // 'register' = new-account activation (issues a session on success);
  // 'edu' = binding a .edu.tw address to an already-logged-in account.
  type: 'register' | 'edu' = 'edu';

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private auth = inject(AuthStore);
  private cdr = inject(ChangeDetectorRef);
  readonly i18n = inject(I18nService);

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      this.type = params['type'] === 'register' ? 'register' : 'edu';
      const token = params['token'];
      if (token) {
        this.inputToken = token;
        this.tokenFromLink = true;
        clearSensitiveParams(this.router, this.route);
        // Activation waits for the registration password; a campus-email
        // link needs nothing more and is sent right away.
        if (this.type !== 'register') this.submitVerify();
      }
    });
  }

  get canSubmit(): boolean {
    return !!this.inputToken && (this.type !== 'register' || !!this.password);
  }

  submitVerify() {
    if (!this.canSubmit) return;

    this.status = 'loading';
    this.passwordError = '';
    this.cdr.detectChanges();

    const request$ = this.type === 'register'
      ? this.auth.verifyRegistration(this.inputToken, this.password)
      : this.auth.verifyEmail(this.inputToken);

    request$.subscribe({
      next: () => {
        this.status = 'success';
        this.cdr.detectChanges();
        setTimeout(() => {
          this.goNext();
        }, 3000);
      },
      error: (err) => {
        const code = err.error?.error?.code;
        // A wrong or missing password keeps the form: the link is still good.
        if (code === 'auth.errActivationPasswordMismatch' || code === 'auth.errActivationPasswordRequired') {
          this.status = 'idle';
          this.passwordError = this.i18n.t(code);
          this.cdr.detectChanges();
          return;
        }
        this.status = 'error';
        this.errorMessage = code ? this.i18n.t(code) : this.i18n.t('verify.errUnknown');
        this.cdr.detectChanges();
      }
    });
  }

  reset() {
    this.status = 'idle';
    this.errorMessage = '';
    this.inputToken = '';
    this.tokenFromLink = false;
    this.password = '';
    this.passwordError = '';
  }

  goNext() {
    // Registration verification already logs the user in (see
    // AuthStore.verifyRegistration) — send them into the app rather than
    // back to a login form they no longer need.
    this.router.navigate(this.regionLink.path([this.type === 'register' ? '/' : '/login']));
  }
}
