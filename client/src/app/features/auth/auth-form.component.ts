import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { Subscription } from 'rxjs';

import { RegionLinkDirective } from '../../core/region-link.directive';
import { RegionLinkService } from '../../core/region-link.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { AuthStore } from '../../core/auth.store';
import { GoogleAuthService } from '../../core/services/google-auth.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { ThemeService } from '../../core/services/theme.service';
import { aboutUrl as aboutSiteUrl } from '../../core/about-site';
import { RegionService } from '../../core/region.service';
import { TurnstileService } from '../../core/services/turnstile.service';

/** The container Google's SDK renders its button into. A DOM id rather than a
 *  ViewChild because the SDK takes an element and writes an iframe into it —
 *  it is not an Angular-rendered control. */
const GOOGLE_BUTTON_ID = 'google-btn';

/** The form-level message (validation failure, server error, post-sign-up
 *  notice). Only one mode renders at a time, so one id serves both. */
const MESSAGE_ID = 'auth-msg';

/** Handed from /register to /login after a successful sign-up, through the
 *  navigation state rather than a query param: the address is personal data
 *  and has no business sitting in a URL that gets shared or bookmarked. */
export interface RegisterHandoff {
  registeredEmail: string;
  registeredNotice: string;
}

/** Both halves of the old /account login wall, now addressable as /login and
 *  /register. One component rather than two near-identical ones: the error
 *  formatting, the field validation and the "you are logged in, leave this
 *  page" rule are the same on both sides, and only the fields differ.
 */
@Component({
  selector: 'app-auth-form',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, FormsModule, UiButton, UiInput, TPipe],
  templateUrl: './auth-form.component.html',
  styleUrls: ['./auth-form.component.css']
})
export class AuthFormComponent implements OnInit, AfterViewInit, OnDestroy {
  private _mode: 'login' | 'register' = 'login';
  @Input()
  get mode(): 'login' | 'register' {
    return this._mode;
  }
  set mode(value: 'login' | 'register') {
    const prev = this._mode;
    this._mode = value;
    if (value === 'register') {
      this.abortConditionalPasskey();
    } else if (value === 'login' && prev !== 'login') {
      void this.initConditionalPasskey();
    }
  }

  email = '';
  password = '';
  registerEmail = '';
  registerPassword = '';
  registerConfirmPassword = '';
  registerFirstName = '';
  registerLastName = '';
  isLoading = false;
  clientAuthError = '';
  lastAuthError: any = null;
  lastAuthAction: 'login' | 'register' = 'login';

  private conditionalAbortController: AbortController | null = null;
  private conditionalSub: Subscription | null = null;
  private conditionalStarted = false;
  authIsError = false;
  returnUrl: string | null = null;

  /** A Turnstile challenge is shown: the page always needs one (sign-in and registration). */
  challengeRequired = false;
  /** The check needs the visitor (a checkbox or puzzle): until then it shows nothing. */
  challengeInteractive = false;
  private challengeToken = '';
  private challengeWidget: string | null = null;
  private challengeSiteKey = '';
  private challengeRendering = false;
  /**
   * The visitor submitted and the challenge has no token yet: the attempt
   * is sent once, when it is solved. While true the button is disabled and
   * reads "verifying", so repeated clicks or Enter do nothing.
   */
  awaitingChallenge = false;
  @ViewChild('challengeBox') private challengeBox?: ElementRef<HTMLElement>;

  private auth = inject(AuthStore);
  private googleAuth = inject(GoogleAuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private regionLink = inject(RegionLinkService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);
  private theme = inject(ThemeService);
  private turnstile = inject(TurnstileService);
  private regionService = inject(RegionService);

  protected readonly MESSAGE_ID = MESSAGE_ID;

  /** Guards against the leave-effect firing twice — it reacts to a signal, and
   *  a second read while the navigation is still in flight would queue a
   *  duplicate navigation. */
  private isLeaving = false;

  /** Carries returnUrl across the login↔register toggle, so a user who
   *  detours to sign up still lands back where the gate interrupted them. */
  get linkQueryParams(): Record<string, string> | null {
    return this.returnUrl ? { returnUrl: this.returnUrl } : null;
  }

  get termsUrl(): string {
    return aboutSiteUrl(this.i18n.lang(), 'about/terms');
  }

  get privacyUrl(): string {
    return aboutSiteUrl(this.i18n.lang(), 'about/privacy');
  }

  /** Points the fields at the form message only while there is one — an
   *  aria-describedby naming a missing element is ignored at best and flagged
   *  as a broken reference by checkers at worst. */
  get messageId(): string | null {
    return this.authMessage ? MESSAGE_ID : null;
  }

  /** A field's own hint plus the form message when one is showing. */
  describedBy(hintId: string): string {
    return this.authMessage ? `${hintId} ${MESSAGE_ID}` : hintId;
  }

  /** The region's campus suffixes for the sign-up hint, formatted the way
   *  account settings formats them (" (.edu.tw, .edu)"). Empty when the
   *  regions have not loaded or an admin left the list blank, so the hint
   *  degrades to the generic sentence instead of printing "()". */
  get eduSuffixesText(): string {
    const suffixes = this.regionService.currentRegionObj()?.edu_email_suffix ?? [];
    return suffixes.length ? ` (${suffixes.join(', ')})` : '';
  }

  get googleReady(): boolean {
    return this.googleAuth.buttonReady();
  }

  get googleSigningIn(): boolean {
    return this.googleAuth.signingIn();
  }

  /** Opening the account chooser or signing in: either way, show a spinner. */
  get googleBusy(): boolean {
    return this.googleAuth.opening() || this.googleAuth.signingIn();
  }

  /** The visitor submitted and the check needs them: only then does the form say so. */
  get challengePrompting(): boolean {
    return this.challengeInteractive && this.awaitingChallenge;
  }

  /** A passkey was chosen (autofill) and the server is checking it. */
  get passkeyVerifying(): boolean {
    return !!this.auth.passkeyVerifying?.();
  }

  get authMessage(): string {
    if (this.challengePrompting) return this.i18n.t('auth.challengePrompt');
    if (this.clientAuthError) return this.i18n.t(this.clientAuthError);
    if (!this.lastAuthError) return '';
    const err = this.lastAuthError;
    if (this.lastAuthAction === 'login') {
      const code = err.error?.error?.code;
      // tOrNull, not t: the backend can return a code no locale declares, and
      // t() would echo it, putting a raw key on the sign-in screen. Nor a
      // `message` from the body: it is English, or a proxy's error page text.
      return this.i18n.tOrNull(code) ?? this.i18n.t('auth.errLoginFailed');
    } else {
      const msg = this.i18n.t('auth.errRegisterFailed');
      let errorDetails = '';
      const fields = err.error?.error?.fields;
      // Field errors are i18n keys; one this locale lacks is left out rather
      // than shown raw.
      const field = (codes: string[]) =>
        codes.map((code: string) => this.i18n.tOrNull(code)).filter(Boolean).join(', ');
      if (fields) {
        if (fields.email) errorDetails += this.i18n.t('auth.errEmailField', {msg: field(fields.email)});
        if (fields.password) errorDetails += this.i18n.t('auth.errPasswordField', {msg: field(fields.password)});
        if (fields.first_name) errorDetails += this.i18n.t('auth.errNameField', {msg: field(fields.first_name)});
        if (fields.last_name) errorDetails += this.i18n.t('auth.errNameField', {msg: field(fields.last_name)});
      } else {
        const code = this.i18n.tOrNull(err.error?.error?.code);
        if (code) errorDetails += ` ${code}`;
      }
      return `${msg}${errorDetails}`;
    }
  }

  constructor() {
    this.returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');

    // Re-render the Google button when the language or the theme changes.
    // resolved(), not mode(): in 'system' mode the OS flipping light/dark
    // never changes mode(), so the button would keep its stale variant.
    effect(() => {
      this.i18n.lang();
      this.theme.resolved();
      this.renderGoogleButton();
    });

    // The password form, the Google button and Google One Tap all report
    // success the same way — AuthStore flips to authenticated — so leaving is
    // decided here once instead of at each of the three call sites, which is
    // how the old One Tap path ended up with no navigation at all.
    effect(() => {
      if (this.auth.isAuthenticated() && !this.isLeaving) {
        this.isLeaving = true;
        this.leaveAuthPage();
      }
    });
  }

  // Not the constructor: `mode` is an @Input and is still at its default there,
  // so a handoff left in history.state would be read on the register page too.
  ngOnInit() {
    this.applyRegisterHandoff();
    if (this.mode === 'login') {
      void this.initConditionalPasskey();
    }
  }

  ngAfterViewInit() {
    this.renderGoogleButton();
    // Sign-in and registration always need a challenge: solve it while the form is filled in.
    if (this.turnstile.siteKey) this.showChallenge(this.turnstile.siteKey);
  }

  onLogin() {
    // One attempt at a time: Enter in a field skips the button's [disabled].
    if (this.isLoading || this.awaitingChallenge) return;
    this.clientAuthError = '';
    this.lastAuthError = null;
    this.lastAuthAction = 'login';
    if (!this.email || !this.password) {
      this.clientAuthError = 'auth.errFillEmailPassword';
      this.authIsError = true;
      return;
    }

    // A challenge was asked for: wait for the visitor to solve it (the
    // widget's callback signs in again with the token).
    if (this.challengeRequired && !this.challengeToken) {
      // The widget is still working on a fresh token: send when it has one.
      this.awaitChallenge();
      return;
    }

    this.isLoading = true;
    // Single-use: a later attempt needs a fresh token. The widget is reset
    // only once the answer is a failure (resetChallenge): resetting it now
    // would rerun the challenge on screen while a sign-in that already has
    // its token goes through.
    const token = this.challengeToken;
    this.challengeToken = '';
    this.auth.login(this.email, this.password, token || undefined).subscribe({
      // No navigation here: the leave-effect above owns that, so the password
      // and Google paths cannot disagree about where a login lands.
      next: () => {
        this.isLoading = false;
        this.authIsError = false;
        // The leave-effect navigates away, but a slow next page (its code
        // still downloading) left the button spinning until then.
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.lastAuthError = err;
        this.authIsError = true;
        if (token) this.resetChallenge();
        const code = err?.error?.error?.code;
        if (code === 'auth.errChallengeRequired' || code === 'auth.errChallengeFailed') {
          this.awaitingChallenge = true;
          this.showChallenge(err.error.error.site_key);
        }
        this.cdr.markForCheck();
      }
    });
  }

  /** Below the fold on a phone, the visitor would not see they are asked. */
  private revealChallenge(): void {
    this.challengeBox?.nativeElement.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }

  /** Ask the widget for a new token: the last one was spent on a request that failed. */
  private resetChallenge(): void {
    if (this.challengeWidget) this.turnstile.reset(this.challengeWidget);
  }

  private async checkConditionalMediation(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const pkc = (window as any).PublicKeyCredential;
    if (!pkc || typeof pkc.isConditionalMediationAvailable !== 'function') {
      return false;
    }
    try {
      return !!(await pkc.isConditionalMediationAvailable());
    } catch {
      return false;
    }
  }

  private async initConditionalPasskey(): Promise<void> {
    if (this.conditionalStarted || this.mode !== 'login') return;
    const available = await this.checkConditionalMediation();
    if (!available || this.mode !== 'login' || this.conditionalStarted) return;

    this.conditionalStarted = true;
    this.conditionalAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    if (typeof this.auth.passkeyLogin === 'function') {
      this.conditionalSub = this.auth.passkeyLogin({ useBrowserAutofill: true }).subscribe({
        next: () => {
          this.conditionalSub = null;
        },
        error: () => {
          this.conditionalSub = null;
          // NotAllowedError/abort is silent
        },
      });
    }
  }

  private abortConditionalPasskey(): void {
    this.conditionalStarted = false;
    if (this.conditionalSub) {
      this.conditionalSub.unsubscribe();
      this.conditionalSub = null;
    }
    if (this.conditionalAbortController) {
      this.conditionalAbortController.abort();
      this.conditionalAbortController = null;
    }
    if (typeof this.auth.cancelPasskey === 'function') {
      this.auth.cancelPasskey();
    }
  }

  private async showChallenge(siteKey: unknown): Promise<void> {
    if (typeof siteKey !== 'string' || !siteKey) return;
    this.challengeSiteKey = siteKey;
    this.challengeRequired = true;
    this.cdr.detectChanges();
    // Shown already: it was reset when its last token was sent, and the
    // fresh token resubmits this attempt (submitWhenSolved). Or on its way.
    if (this.challengeWidget || this.challengeRendering) return;
    if (!this.challengeBox) return;
    this.challengeRendering = true;
    try {
      this.challengeWidget = await this.turnstile.render(this.challengeBox.nativeElement, {
        siteKey,
        language: this.i18n.lang(),
        theme: this.theme.resolved(),
        onToken: (t) => {
          this.challengeToken = t;
          // Only an attempt the visitor made is resent, and only once: the
          // widget can hand out a new token by itself (on expiry, or right
          // away in non-interactive mode), which must not sign in again.
          if (this.awaitingChallenge) {
            this.awaitingChallenge = false;
            if (this.mode === 'register') this.onRegister();
            else this.onLogin();
          }
          this.cdr.markForCheck();
        },
        onInteractive: (needed) => {
          this.challengeInteractive = needed;
          this.cdr.detectChanges();
          if (needed && this.awaitingChallenge) this.revealChallenge();
        },
        onError: () => {
          // Failed, expired or timed out: Turnstile retries by itself; the
          // button is usable again so the visitor is not left waiting on nothing.
          this.challengeToken = '';
          if (this.awaitingChallenge) {
            this.awaitingChallenge = false;
            this.clientAuthError = 'auth.errChallengeFailed';
            this.authIsError = true;
          }
          this.cdr.markForCheck();
        },
      });
    } catch {
      // The script did not load (a blocker, or no route to Cloudflare), so
      // there will be no token. Silent on opening the page; but a visitor who
      // submitted must not be left on "verifying" for good.
      if (this.awaitingChallenge) {
        this.awaitingChallenge = false;
        this.clientAuthError = 'auth.errChallengeUnavailable';
        this.authIsError = true;
      }
      this.cdr.markForCheck();
    } finally {
      this.challengeRendering = false;
    }
  }

  /** Waiting for a token the widget has not got: load it again if it never came up. */
  private awaitChallenge(): void {
    this.awaitingChallenge = true;
    if (!this.challengeWidget && !this.challengeRendering) void this.showChallenge(this.challengeSiteKey);
    else if (this.challengeInteractive) this.revealChallenge();
    this.cdr.markForCheck();
  }

  ngOnDestroy() {
    this.abortConditionalPasskey();
    if (this.challengeWidget) this.turnstile.remove(this.challengeWidget);
  }

  onRegister() {
    this.clientAuthError = '';
    this.lastAuthError = null;
    this.lastAuthAction = 'register';
    if (!this.registerEmail || !this.registerPassword || !this.registerFirstName || !this.registerLastName) {
      this.clientAuthError = 'auth.errFillAll';
      this.authIsError = true;
      return;
    }

    if (this.registerPassword !== this.registerConfirmPassword) {
      this.clientAuthError = 'auth.errPasswordMismatch';
      this.authIsError = true;
      return;
    }

    if (this.isLoading || this.awaitingChallenge) return;
    // Asked for before: wait for the widget's token (see onLogin).
    if (this.challengeRequired && !this.challengeToken) {
      this.awaitChallenge();
      return;
    }

    this.isLoading = true;
    const token = this.challengeToken;
    this.challengeToken = '';
    this.auth.register(this.registerEmail, this.registerPassword, this.registerFirstName, this.registerLastName, token || undefined).subscribe({
      next: () => {
        // New accounts start inactive — login is blocked until the emailed
        // activation link is clicked, so there's no account to auto-login
        // into yet. Send them to /login with the email prefilled so it's
        // ready the moment they come back after verifying.
        this.isLoading = false;
        const handoff: RegisterHandoff = {
          registeredEmail: this.registerEmail,
          registeredNotice: 'auth.registerSuccess'
        };
        this.router.navigate(this.regionLink.path(['/login']), {
          queryParams: this.returnUrl ? { returnUrl: this.returnUrl } : {},
          state: handoff
        });
      },
      error: (err) => {
        this.isLoading = false;
        this.lastAuthError = err;
        this.authIsError = true;
        if (token) this.resetChallenge();
        const code = err?.error?.error?.code;
        if (code === 'auth.errChallengeRequired' || code === 'auth.errChallengeFailed') {
          this.awaitingChallenge = true;
          this.showChallenge(err.error.error.site_key);
        }
        this.cdr.markForCheck();
      }
    });
  }

  private leaveAuthPage() {
    // replaceUrl: otherwise Back returns to /login, whose guard immediately
    // bounces the now-logged-in user forward again — a Back button that
    // visibly does nothing.
    const target = this.returnUrl || this.regionLink.path(['/account']);
    if (typeof target === 'string') {
      this.router.navigateByUrl(target, { replaceUrl: true });
    } else {
      this.router.navigate(target, { replaceUrl: true });
    }
  }

  // Rendered on /register too: GoogleLoginView creates the account when the
  // address is new, so "Continue with Google" is as much a sign-up as a login,
  // and the leave-effect above handles either outcome the same way.
  private renderGoogleButton() {
    // Deferred a macrotask: the SDK measures the container to size the button,
    // and reads 0 if it runs before the element is laid out — which is exactly
    // what happens when this is triggered from the language/theme effect.
    setTimeout(() => this.googleAuth.renderButton(GOOGLE_BUTTON_ID), 0);
  }

  /** Picks up the prefill and the "activation link sent" notice that
   *  onRegister() handed over. Read from history.state because the router
   *  writes navigation state there before it activates this component. */
  private applyRegisterHandoff() {
    if (this.mode === 'register') return;
    const state = (this.router.getCurrentNavigation()?.extras?.state
      ?? (typeof history !== 'undefined' ? history.state : null)) as Partial<RegisterHandoff> | null;
    if (!state?.registeredEmail) return;
    this.email = state.registeredEmail;
    this.clientAuthError = state.registeredNotice || '';
    this.authIsError = false;
  }
}
