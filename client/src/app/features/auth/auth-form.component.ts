import { AfterViewInit, ChangeDetectorRef, Component, Input, OnInit, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';

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
export class AuthFormComponent implements OnInit, AfterViewInit {
  @Input() mode: 'login' | 'register' = 'login';

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
  authIsError = false;
  returnUrl: string | null = null;

  private auth = inject(AuthStore);
  private googleAuth = inject(GoogleAuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private regionLink = inject(RegionLinkService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);
  private theme = inject(ThemeService);
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

  get authMessage(): string {
    if (this.clientAuthError) return this.i18n.t(this.clientAuthError);
    if (!this.lastAuthError) return '';
    const err = this.lastAuthError;
    if (this.lastAuthAction === 'login') {
      const code = err.error?.error?.code;
      // tOrNull, not t: the backend can return a code no locale declares, and
      // t() would echo it, putting a raw key on the sign-in screen.
      return this.i18n.tOrNull(code)
        ?? err.error?.error?.message
        ?? this.i18n.t('auth.errLoginFailed');
    } else {
      const msg = this.i18n.t('auth.errRegisterFailed');
      let errorDetails = '';
      const fields = err.error?.error?.fields;
      // Field errors come back as i18n keys when the backend has one and as
      // plain prose when it doesn't, so each falls back to itself.
      const field = (messages: string[]) =>
        messages.map((e: string) => this.i18n.tOrNull(e) ?? e).join(', ');
      if (fields) {
        if (fields.email) errorDetails += this.i18n.t('auth.errEmailField', {msg: field(fields.email)});
        if (fields.password) errorDetails += this.i18n.t('auth.errPasswordField', {msg: field(fields.password)});
        if (fields.first_name) errorDetails += this.i18n.t('auth.errNameField', {msg: field(fields.first_name)});
        if (fields.last_name) errorDetails += this.i18n.t('auth.errNameField', {msg: field(fields.last_name)});
        if (fields.non_field_errors) errorDetails += ` ${field(fields.non_field_errors)}`;
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
  }

  ngAfterViewInit() {
    this.renderGoogleButton();
  }

  onLogin() {
    this.clientAuthError = '';
    this.lastAuthError = null;
    this.lastAuthAction = 'login';
    if (!this.email || !this.password) {
      this.clientAuthError = 'auth.errFillEmailPassword';
      this.authIsError = true;
      return;
    }

    this.isLoading = true;
    this.auth.login(this.email, this.password).subscribe({
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
        this.cdr.markForCheck();
      }
    });
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

    this.isLoading = true;
    this.auth.register(this.registerEmail, this.registerPassword, this.registerFirstName, this.registerLastName).subscribe({
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
