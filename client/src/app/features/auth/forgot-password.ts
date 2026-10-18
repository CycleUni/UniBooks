import { AfterViewInit, Component, OnInit, OnDestroy, ElementRef, ViewChild, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiSuccessCheck } from '../../shared/ui/success-check.component';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../../core/auth.store';
import { I18nService, TPipe } from '../../core/i18n.service';
import { RegionLinkService } from '../../core/region-link.service';
import { clearSensitiveParams } from '../../core/sensitive-url';
import { TurnstileService } from '../../core/services/turnstile.service';
import { ThemeService } from '../../core/services/theme.service';


@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, UiButton, UiInput, UiSuccessCheck, TPipe],
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

              <!-- Turnstile renders here: asking for a link always needs a challenge. -->
              <div #challengeBox class="challenge-box" [class.interactive]="challengeInteractive" [hidden]="!challengeRequired"></div>

              <div *ngIf="challengePrompting || errorMessage" class="error-msg">{{ challengePrompting ? ('auth.challengePrompt' | t) : errorMessage }}</div>

              <ui-button  block (onClick)="submitRequest()" [disabled]="!email || requestStatus === 'loading' || awaitingChallenge">
                {{ (requestStatus === 'loading' ? 'fp.sending' : awaitingChallenge ? 'auth.verifyingChallenge' : 'fp.sendLink') | t }}
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
              <div class="success-icon"><ui-success-check></ui-success-check></div>
              <h2>{{ 'fp.successTitle' | t }}</h2>
              <p>{{ 'fp.successBody' | t }}</p>
              <ui-button  class="mt-5" (onClick)="goToLogin()">{{ 'verify.goToLogin' | t }}</ui-button>
            </ng-container>
          </ng-container>
        </div>
      </div>
  `,
  styles: [`
    .success-icon {
      margin-bottom: 16px;
    }
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
    /* Takes no room until Cloudflare needs the visitor: clipped to nothing, so
       whatever the widget keeps inside it while hidden cannot push the form apart. */
    .challenge-box {
      display: flex;
      justify-content: center;
      height: 0;
      overflow: hidden;
    }
    .challenge-box.interactive {
      height: auto;
      overflow: visible;
      margin-top: 12px;
      min-height: 65px;
    }
    /* display:flex above would otherwise override the hidden attribute. */
    .challenge-box[hidden] {
      display: none;
    }
    .error-msg {
      color: var(--flag);
      font-weight: 500;
      font-size: var(--text-base);
      margin: 12px 0;
    }
  `]
})
export class ForgotPassword implements OnInit, AfterViewInit, OnDestroy {
  token = '';
  email = '';
  newPassword = '';
  confirmPassword = '';
  errorMessage = '';

  requestStatus: 'idle' | 'loading' | 'sent' = 'idle';
  confirmStatus: 'idle' | 'loading' | 'success' = 'idle';

  /** The server asked for a Turnstile challenge, which a reset link request always needs. */
  challengeRequired = false;
  /** Submitted with no token yet: sent once, when the challenge is solved. */
  awaitingChallenge = false;
  /** The check needs the visitor (a checkbox or puzzle): until then it shows nothing. */
  challengeInteractive = false;
  private challengeToken = '';
  private challengeWidget: string | null = null;
  private challengeSiteKey = '';
  private challengeRendering = false;
  @ViewChild('challengeBox') private challengeBox?: ElementRef<HTMLElement>;

  private turnstile = inject(TurnstileService);
  private theme = inject(ThemeService);
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

  /** The visitor submitted and the check needs them: only then does the page say so. */
  get challengePrompting(): boolean {
    return this.challengeInteractive && this.awaitingChallenge;
  }

  ngAfterViewInit() {
    // Asking for a link always needs a challenge: solve it while the address is typed.
    if (!this.token && this.turnstile.siteKey) this.showChallenge(this.turnstile.siteKey);
  }

  submitRequest() {
    if (!this.email || this.requestStatus === 'loading' || this.awaitingChallenge) return;
    // Asked for before: wait for the widget's token.
    if (this.challengeRequired && !this.challengeToken) {
      this.awaitingChallenge = true;
      // Never came up (the script did not load): try again rather than wait for good.
      if (!this.challengeWidget && !this.challengeRendering) void this.showChallenge(this.challengeSiteKey);
      else if (this.challengeInteractive) this.revealChallenge();
      this.cdr.markForCheck();
      return;
    }
    this.requestStatus = 'loading';
    this.errorMessage = '';
    this.cdr.markForCheck();

    // Single-use: a later attempt needs a fresh token. The widget is reset
    // only when the request fails, not while it goes through.
    const token = this.challengeToken;
    this.challengeToken = '';
    this.auth.requestPasswordReset(this.email, token || undefined).subscribe({
      // Always the same success state regardless of whether the email
      // exists — the backend deliberately doesn't reveal that either.
      next: () => {
        this.requestStatus = 'sent';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.requestStatus = 'idle';
        if (token && this.challengeWidget) this.turnstile.reset(this.challengeWidget);
        const code = err.error?.error?.code;
        if (code === 'auth.errChallengeRequired' || code === 'auth.errChallengeFailed') {
          this.awaitingChallenge = true;
          this.showChallenge(err.error.error.site_key);
          this.cdr.markForCheck();
          return;
        }
        this.errorMessage = code ? this.i18n.t(code) : this.i18n.t('verify.errUnknown');
        this.cdr.markForCheck();
      }
    });
  }

  /** Below the fold on a phone, the visitor would not see they are asked. */
  private revealChallenge(): void {
    this.challengeBox?.nativeElement.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }

  private async showChallenge(siteKey: unknown): Promise<void> {
    if (typeof siteKey !== 'string' || !siteKey) return;
    this.challengeSiteKey = siteKey;
    this.challengeRequired = true;
    this.cdr.detectChanges();
    // Shown already: it was reset when its last token was sent. Or on its way.
    if (this.challengeWidget || this.challengeRendering || !this.challengeBox) return;
    this.challengeRendering = true;
    try {
      this.challengeWidget = await this.turnstile.render(this.challengeBox.nativeElement, {
        siteKey,
        language: this.i18n.lang(),
        theme: this.theme.resolved(),
        onToken: (t) => {
          this.challengeToken = t;
          // Only an attempt the visitor made is sent, and only once: the
          // widget can hand out a new token by itself, which must not
          // send another email.
          if (this.awaitingChallenge) {
            this.awaitingChallenge = false;
            this.submitRequest();
          }
          this.cdr.markForCheck();
        },
        onInteractive: (needed) => {
          this.challengeInteractive = needed;
          this.cdr.detectChanges();
          if (needed && this.awaitingChallenge) this.revealChallenge();
        },
        onError: () => {
          this.challengeToken = '';
          if (this.awaitingChallenge) {
            this.awaitingChallenge = false;
            this.errorMessage = this.i18n.t('auth.errChallengeFailed');
          }
          this.cdr.markForCheck();
        },
      });
    } catch {
      // The script did not load: silent on opening the page, but a visitor who
      // submitted must not be left on "verifying" for good.
      if (this.awaitingChallenge) {
        this.awaitingChallenge = false;
        this.errorMessage = this.i18n.t('auth.errChallengeUnavailable');
      }
      this.cdr.markForCheck();
    } finally {
      this.challengeRendering = false;
    }
  }

  ngOnDestroy() {
    if (this.challengeWidget) this.turnstile.remove(this.challengeWidget);
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
