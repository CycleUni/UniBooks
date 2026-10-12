import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { ChangeDetectorRef } from '@angular/core';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../../core/auth.store';
import { I18nService, TPipe } from '../../core/i18n.service';
import { RegionLinkService } from '../../core/region-link.service';
import { clearSensitiveParams } from '../../core/sensitive-url';


@Component({
  selector: 'app-verify',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, UiButton, UiInput, TPipe],
  template: `
      <div class="verify-container">
        <div class="verify-box">
          <ng-container *ngIf="status === 'idle' || status === 'loading'">
            <h2>{{ 'verify.title' | t }}</h2>
            <p>{{ 'verify.hint' | t }}</p>

            <div  style="margin: 24px 0; text-align: left;">
              <ui-input [placeholder]="'verify.tokenPlaceholder' | t" [(ngModel)]="inputToken" [disabled]="status === 'loading'"></ui-input>
            </div>

            <ui-button  block (onClick)="submitVerify()" [disabled]="!inputToken || status === 'loading'">
              {{ (status === 'loading' ? 'verify.verifying' : 'verify.submit') | t }}
            </ui-button>
          </ng-container>

          <ng-container *ngIf="status === 'success'">
            <div class="success-icon">
              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="32" cy="32" r="30" stroke="var(--success)" stroke-width="4" fill="none"/>
                <path d="M20 32 L28 46 L44 20" stroke="var(--success)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              </svg>
            </div>
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
        clearSensitiveParams(this.router, this.route);
        this.submitVerify();
      }
    });
  }

  submitVerify() {
    if (!this.inputToken) return;

    this.status = 'loading';
    this.cdr.detectChanges();

    const request$ = this.type === 'register'
      ? this.auth.verifyRegistration(this.inputToken)
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
        this.status = 'error';
        const code = err.error?.error?.code;
        this.errorMessage = code ? this.i18n.t(code) : this.i18n.t('verify.errUnknown');
        this.cdr.detectChanges();
      }
    });
  }

  reset() {
    this.status = 'idle';
    this.errorMessage = '';
    this.inputToken = '';
  }

  goNext() {
    // Registration verification already logs the user in (see
    // AuthStore.verifyRegistration) — send them into the app rather than
    // back to a login form they no longer need.
    this.router.navigate(this.regionLink.path([this.type === 'register' ? '/' : '/login']));
  }
}
